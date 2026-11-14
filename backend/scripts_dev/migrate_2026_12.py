"""Migration idempotente novembre 2026 — chantier « générateur d'épreuves
V4.10 ».

Crée, si elles manquent, les cinq tables du générateur :

- ``banque_parties`` — parties par matière (règle 4.a) ;
- ``banque_classes_meta`` — présence d'un examen et obligation de spécialité
  par classe (cahier 3.2.c) ;
- ``banque_exercices`` — sujets + corrigés, multi-matières/classes/séries ;
- ``banque_generations`` — épreuves composées par élève (unicité 4.i) ;
- ``banque_journal`` — journal technique (cahier 7.1).

Puis deux amorçages idempotents :

- les trois classes à examen du secondaire (``3e`` BEPC, ``1ere``
  PROBATOIRE, ``terminale`` BAC) reçoivent ``a_examen = 1`` : sans cela, la
  remontée 4.e se limite à un niveau partout et le générateur ne peut jamais
  atteindre les deux niveaux prévus par le cahier. Les autres classes gardent
  le défaut (sans examen, spécialité facultative) et restent modifiables par
  l'admin ;
- aucun exercice n'est inséré : la banque démarre vide, ce qui est un état
  valide (épreuve vide silencieuse) mais doit être rempli avant ouverture
  (import JSON ou atelier IA + relecture).

``create_all`` ne crée QUE les tables absentes : le script peut être rejoué
autant de fois que nécessaire, sans effet sur les données existantes.

Usage : cd backend && python -m scripts_dev.migrate_2026_12
"""

from __future__ import annotations

import json

from sqlalchemy import inspect, text

from app.core.logging_config import get_logger
from app.db import engine
from app.db_models import Base

log = get_logger("migrate_2026_12")

#: Classes du secondaire qui préparent un examen certificiel, d'après
#: ``core.referentiel._CLASSE_PAR_DEFAUT_EVALUATION`` (BEPC, PROBATOIRE, BAC).
CLASSES_A_EXAMEN: tuple[str, ...] = ("3e", "1ere", "terminale")

#: Index déclarés dans l'ORM : `create_all` ne les pose pas sur une table déjà
#: présente, et une base ancienne les paierait en scan complet.
INDEX_ATTENDUS: dict[str, list[tuple[str, str]]] = {
    "banque_generations": [("ix_banque_generations_user_created", "user_id, created_at")],
    "banque_journal": [("ix_banque_journal_type_created", "type, created_at")],
}


def _create_missing_tables() -> list[str]:
    before = set(inspect(engine).get_table_names())
    Base.metadata.create_all(engine)
    created = sorted(set(inspect(engine).get_table_names()) - before)
    for table in created:
        log.info("Table créée : %s", table)
    return created


def _ensure_indexes() -> list[str]:
    """Pose les index composites absents sur des tables déjà existantes."""
    poses: list[str] = []
    with engine.begin() as conn:
        insp = inspect(conn)
        tables = set(insp.get_table_names())
        for table, index_list in INDEX_ATTENDUS.items():
            if table not in tables:
                continue
            existants = {i["name"] for i in insp.get_indexes(table)}
            for nom, colonnes in index_list:
                if nom in existants:
                    continue
                conn.execute(text(f"CREATE INDEX IF NOT EXISTS {nom} ON {table} ({colonnes})"))
                poses.append(nom)
                log.info("Index créé : %s", nom)
    return poses


def _semis_classes_a_examen() -> int:
    """Marque ``a_examen`` sur les classes certificielles, sans jamais écraser
    un réglage existant (idempotence et respect de la configuration admin)."""
    count = 0
    with engine.begin() as conn:
        insp = inspect(conn)
        if "banque_classes_meta" not in set(insp.get_table_names()):
            return 0
        for classe in CLASSES_A_EXAMEN:
            existe = conn.execute(
                text("SELECT 1 FROM banque_classes_meta WHERE classe = :c"), {"c": classe}
            ).first()
            if existe:
                continue
            conn.execute(
                text(
                    "INSERT INTO banque_classes_meta "
                    "(classe, a_examen, specialite_obligatoire) "
                    "VALUES (:c, 1, 0)"
                ),
                {"c": classe},
            )
            count += 1
            log.info("Classe à examen configurée : %s", classe)
    return count


def main() -> None:
    tables = _create_missing_tables()
    index = _ensure_indexes()
    classes = _semis_classes_a_examen()
    log.info(
        "Migration 2026-12 terminée — tables créées : %s ; index créés : %s ; "
        "classes à examen amorcées : %d",
        tables or "aucune (déjà à jour)",
        json.dumps(index) if index else "aucun (déjà présents)",
        classes,
    )


if __name__ == "__main__":
    main()
