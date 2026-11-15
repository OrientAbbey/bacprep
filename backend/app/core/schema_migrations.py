"""Migrations de schéma idempotentes, rejouables sans risque.

`Base.metadata.create_all` ne crée QUE les tables absentes : il n'ajoute
jamais une colonne à une table existante. Une base déployée avant un chantier
qui touche au schéma reste donc en retard, et l'ORM échoue à la première
requête (`UndefinedColumn: plans.prix_ak`), ce qui a produit un `500` sur
`/api/pricing` et sur les routes qui lisent `users.matricule` / `users.solde_ak`
(connexion comprise).

Ces réparations étaient auparavant confiées à `scripts_dev/migrate_2026_11.py`,
qu'un déploiement Render n'exécute pas : oublier la commande suffisait à casser
le service. Elles sont désormais appliquées **au démarrage** — une étape
manuelle en moins à ne pas oublier — et le script reste disponible pour les
réparations hors ligne (base gelée, audit, rétrofill massif).

Toutes les étapes sont testées avant application : rejouer la fonction sur une
base déjà à jour ne fait rien.
"""
from __future__ import annotations

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from .logging_config import get_logger

log = get_logger("schema_migrations")

# Renommages appliqués AVANT les ajouts de colonnes : une base créée entre deux
# versions peut encore porter les anciens noms. Le premier élément est l'ancien
# nom, le second le nouveau ; si les deux existent, on ne touche à rien.
RENAMES: dict[str, list[tuple[str, str]]] = {
    "plans": [
        ("nom_fr", "libelle"),
        ("nom_en", "libelle_en"),
        ("description_fr", "description"),
    ],
}

# Colonnes à ajouter si absentes : table -> [(colonne, définition SQL), ...].
# SQLite ne sait pas ajouter une colonne NOT NULL sans défaut : toutes celles
# qui sont NOT NULL en portent un. La syntaxe est acceptée telle quelle par
# SQLite et PostgreSQL.
COLUMNS: dict[str, list[tuple[str, str]]] = {
    "users": [
        ("matricule", "VARCHAR(16)"),
        ("solde_ak", "INTEGER NOT NULL DEFAULT 0"),
        ("ak_serie_jours", "INTEGER NOT NULL DEFAULT 0"),
        ("ak_dernier_jour", "VARCHAR(10)"),
    ],
    "plans": [
        ("prix_ak", "INTEGER"),
    ],
    "payments": [
        ("monnaie", "VARCHAR(3) NOT NULL DEFAULT 'XAF'"),
    ],
}

# Index déclarés dans l'ORM : `create_all` ne les pose pas sur une table déjà
# présente. (colonne -> nom de l'index, DDL)
INDEXES: dict[str, list[tuple[str, str]]] = {
    "users": [
        ("ix_users_matricule", "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_matricule ON users (matricule)"),
    ],
    "plans": [
        ("ix_plans_scope", "CREATE INDEX IF NOT EXISTS ix_plans_scope ON plans (scope)"),
    ],
}


def reparer_schema(engine) -> dict[str, list[str]]:
    """Renomme les anciennes colonnes puis ajoute celles qui manquent.

    Retourne le détail de ce qui a été appliqué (vide = base déjà à jour).
    """
    renommees: list[str] = []
    ajoutees: list[str] = []

    with engine.begin() as conn:
        insp = inspect(conn)
        tables = set(insp.get_table_names())

        for table, renames in RENAMES.items():
            if table not in tables:
                continue
            existantes = {c["name"] for c in insp.get_columns(table)}
            for ancien, nouveau in renames:
                if ancien not in existantes or nouveau in existantes:
                    continue
                conn.execute(text(f"ALTER TABLE {table} RENAME COLUMN {ancien} TO {nouveau}"))
                renommees.append(f"{table}.{ancien}→{nouveau}")
                log.info("Colonne renommée : %s.%s → %s", table, ancien, nouveau)

        # Les colonnes ajoutées à l'étape précédente comptent comme présentes.
        for table, columns in COLUMNS.items():
            if table not in tables:
                continue
            existantes = {c["name"] for c in insp.get_columns(table)}
            for nom, ddl in columns:
                if nom in existantes:
                    continue
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {nom} {ddl}"))
                ajoutees.append(f"{table}.{nom}")
                log.info("Colonne ajoutée : %s.%s", table, nom)

    return {"renommees": renommees, "ajoutees": ajoutees}


def assurer_index(engine) -> list[str]:
    """Crée les index absents des tables déjà existantes (idempotent)."""
    crees: list[str] = []
    with engine.begin() as conn:
        insp = inspect(conn)
        tables = set(insp.get_table_names())
        for table, index in INDEXES.items():
            if table not in tables:
                continue
            existants = {ix["name"] for ix in insp.get_indexes(table)}
            for nom, ddl in index:
                if nom in existants:
                    continue
                conn.execute(text(ddl))
                crees.append(nom)
                log.info("Index créé : %s", nom)
    return crees


def retrofill_matricules(db: Session) -> int:
    """Attribue un matricule aux comptes antérieurs au chantier « matricule ».

    Un `commit` par lot de 200 : sur une base de quelques milliers de comptes,
    on évite de tenir une transaction longue pendant que le service tourne.
    """
    from ..db_models import UserORM
    from .matricule import generer_matricule

    manquants = (
        db.query(UserORM)
        .filter((UserORM.matricule.is_(None)) | (UserORM.matricule == ""))
        .all()
    )
    if not manquants:
        return 0

    pris = {m for (m,) in db.query(UserORM.matricule).filter(UserORM.matricule.isnot(None)).all()}
    count = 0
    for user in manquants:
        candidat = generer_matricule()
        while candidat in pris:  # collision : on retire
            candidat = generer_matricule()
        pris.add(candidat)
        user.matricule = candidat
        db.add(user)
        count += 1
        if count % 200 == 0:
            db.commit()
    db.commit()
    return count


def retrofill_prix_ak(db: Session) -> int:
    """Applique les prix AK par défaut aux formules qui n'en ont pas.

    Le ratio retenu (~16 FCFA/AK) est documenté dans `core/plans._DEFAUTS_AK`.
    Un `prix_ak` déjà saisi par l'admin n'est jamais écrasé (idempotence).
    """
    from ..db_models import PlanORM
    from .plans import _DEFAUTS_AK

    count = 0
    for plan in db.query(PlanORM).filter(PlanORM.prix_ak.is_(None)).all():
        valeur = _DEFAUTS_AK.get(plan.scope)
        if valeur is None:
            continue
        plan.prix_ak = valeur
        db.add(plan)
        count += 1
    if count:
        db.commit()
    return count
