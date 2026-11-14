"""Migration idempotente novembre 2026 — chantier « matricule + monnaie AK ».

Ajoute, si elles manquent, les colonnes et la table du chantier :

- ``users.matricule`` — identifiant public dictable (index UNIQUE) ;
- ``users.solde_ak`` / ``ak_serie_jours`` / ``ak_dernier_jour`` — monnaie
  interne et série de connexions ;
- ``plans.prix_ak`` — prix en AK d'une formule (NULL = non payable en AK) ;
- ``payments.monnaie`` — ``"XAF"`` (défaut) ou ``"AK"``, pour que les
  agrégats financiers puissent exclure les achats en monnaie interne ;
- table ``ak_mouvements`` (journal signé, source de vérité comptable).

Il remet aussi à niveau une base créée avant le renommage des colonnes de
``plans`` (``nom_fr``/``nom_en``/``description_fr`` → ``libelle``/``libelle_en``/
``description``) : sans cela, une telle base ne peut plus servir la page
Abonnement, et le rétrofill ``prix_ak`` échouerait sur ``plans.libelle``.

Puis rétrofill : un matricule pour chaque compte qui n'en a pas, et les
``prix_ak`` par défaut des formules existantes (le seed n'écrit jamais dans
une table ``plans`` déjà peuplée — voir ``core/plans.seed_plans``).

Chaque étape est testée avant application : le script peut être rejoué
autant de fois que nécessaire.

Usage : cd backend && python -m scripts_dev.migrate_2026_11
"""

from __future__ import annotations

import json

from sqlalchemy import inspect, text

from app.core import matricule
from app.core.logging_config import get_logger
from app.db import SessionLocal, engine
from app.db_models import Base

log = get_logger("migrate_2026_11")

# Renommages de colonnes appliqués avant les ajouts : une base de dev créée
# entre-temps peut encore porter les anciens noms (voir docstring). Le premier
# nom est l'ancien, le second le nouveau ; si les deux existent, on ne touche
# à rien (base déjà migrée, ou renommage partiel rattrapé par l'ajout).
RENAMES: dict[str, list[tuple[str, str]]] = {
    "plans": [
        ("nom_fr", "libelle"),
        ("nom_en", "libelle_en"),
        ("description_fr", "description"),
    ],
}

# Colonnes à ajouter si absentes : table -> [(colonne, définition SQL), ...]
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


def _rename_old_columns() -> list[str]:
    """Remet les anciens noms de colonnes de ``plans`` à leur nom actuel.

    Le renommage est fait AVANT les ajouts : sinon ``plans.libelle`` resterait
    absente et le rétrofill ``prix_ak`` (qui passe par l'ORM) échouerait sur
    une base ancienne.
    """
    applied: list[str] = []
    with engine.begin() as conn:
        insp = inspect(conn)
        tables = set(insp.get_table_names())
        for table, renames in RENAMES.items():
            if table not in tables:
                continue
            existing = {c["name"] for c in insp.get_columns(table)}
            for old, new in renames:
                if old not in existing or new in existing:
                    continue
                conn.execute(text(f"ALTER TABLE {table} RENAME COLUMN {old} TO {new}"))
                applied.append(f"{table}.{old}→{new}")
                log.info("Colonne renommée: %s.%s → %s", table, old, new)
    return applied


def _add_missing_columns() -> list[str]:
    """ALTER TABLE conditionnel. SQLite ne sait pas ajouter une colonne
    NOT NULL sans défaut : toutes celles qui sont NOT NULL en portent un."""
    applied: list[str] = []
    with engine.begin() as conn:
        insp = inspect(conn)
        tables = set(insp.get_table_names())
        for table, columns in COLUMNS.items():
            if table not in tables:
                continue
            existing = {c["name"] for c in insp.get_columns(table)}
            for name, ddl in columns:
                if name in existing:
                    continue
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
                applied.append(f"{table}.{name}")
                log.info("Colonne ajoutée: %s.%s", table, name)
    return applied


def _create_missing_tables() -> list[str]:
    """`create_all` ne crée QUE les tables absentes (jamais de destructif)."""
    before = set(inspect(engine).get_table_names())
    Base.metadata.create_all(engine)
    created = set(inspect(engine).get_table_names()) - before
    for t in sorted(created):
        log.info("Table créée: %s", t)
    return sorted(created)


def _ensure_matricule_index() -> bool:
    """Crée l'index UNIQUE sur `users.matricule` s'il n'existe pas.

    SQLite accepte un index UNIQUE sur une colonne contenant des NULL (les
    NULL ne se comparent pas entre eux) : on peut donc le poser AVANT le
    rétrofill, contrairement à une contrainte NOT NULL.
    """
    with engine.begin() as conn:
        insp = inspect(conn)
        if "users" not in set(insp.get_table_names()):
            return False
        noms = {i["name"] for i in insp.get_indexes("users")}
        if "ix_users_matricule" in noms:
            return False
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_matricule ON users (matricule)"))
        log.info("Index créé: ix_users_matricule")
        return True


def _ensure_plans_scope_index() -> bool:
    """Index non unique sur `plans.scope` (déclaré `index=True` dans l'ORM).

    `create_all` ne pose pas les index des tables déjà présentes : une base
    ancienne n'a donc pas cet index, et la page Abonnement le paierait en
    scan complet à chaque requête.
    """
    with engine.begin() as conn:
        insp = inspect(conn)
        if "plans" not in set(insp.get_table_names()):
            return False
        noms = {i["name"] for i in insp.get_indexes("plans")}
        if "ix_plans_scope" in noms:
            return False
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_plans_scope ON plans (scope)"))
        log.info("Index créé: ix_plans_scope")
        return True


def _backfill_matricules() -> int:
    """Attribue un matricule aux comptes antérieurs à la migration.

    Un commit par lot de 200 : sur une base de quelques milliers de comptes,
    évite de tenir une transaction longue pendant que le service tourne.
    """
    from app.db_models import UserORM

    count = 0
    with SessionLocal() as db:
        manquants = (
            db.query(UserORM)
            .filter((UserORM.matricule.is_(None)) | (UserORM.matricule == ""))
            .all()
        )
        pris = {m for (m,) in db.query(UserORM.matricule).filter(UserORM.matricule.isnot(None)).all()}
        for u in manquants:
            candidat = matricule.generer_matricule()
            while candidat in pris:  # collision : on retire
                candidat = matricule.generer_matricule()
            pris.add(candidat)
            u.matricule = candidat
            db.add(u)
            count += 1
            if count % 200 == 0:
                db.commit()
        db.commit()
    return count


def _backfill_prix_ak() -> int:
    """Applique les prix AK par défaut aux formules qui n'en ont pas.

    Le ratio retenu (~16 FCFA/AK) est documenté dans `core/plans._DEFAUTS_AK`.
    On ne touche jamais à un `prix_ak` déjà saisi par l'admin (idempotence).
    """
    from app.core.plans import _DEFAUTS_AK
    from app.db_models import PlanORM

    count = 0
    with SessionLocal() as db:
        for plan in db.query(PlanORM).filter(PlanORM.prix_ak.is_(None)).all():
            valeur = _DEFAUTS_AK.get(plan.scope)
            if valeur is None:
                continue
            plan.prix_ak = valeur
            db.add(plan)
            count += 1
        db.commit()
    return count


def main() -> None:
    renames = _rename_old_columns()
    columns = _add_missing_columns()
    tables = _create_missing_tables()
    index = _ensure_matricule_index()
    scope_index = _ensure_plans_scope_index()
    matricules = _backfill_matricules()
    prix_ak = _backfill_prix_ak()
    log.info(
        "Migration 2026-11 terminée — renommages: %s ; colonnes: %s ; tables: %s ; "
        "index créés: %s ; matricules attribués: %d ; prix AK complétés: %d",
        json.dumps(renames) if renames else "aucun (déjà à jour)",
        json.dumps(columns) if columns else "aucune (déjà à jour)",
        tables or "aucune (déjà à jour)",
        ", ".join(n for n, ok in (("ix_users_matricule", index), ("ix_plans_scope", scope_index)) if ok)
        or "aucun (déjà présents)",
        matricules,
        prix_ak,
    )


if __name__ == "__main__":
    main()
