"""Migration idempotente « multi-sujets » — ajoute la colonne
`epreuve_files.sujet_index` (INTEGER NOT NULL DEFAULT 0) aux bases créées
avant ce chantier.

La valeur 0 correspond au sujet principal : ses documents gardent leurs
clés historiques (`sujet.md`/`corrige.md`) et aucune donnée existante
n'est déplacée. Les sujets supplémentaires (index 1, 2…) n'existent
qu'à la création via le formulaire admin.

S'exécute plusieurs fois sans effet de bord (ALTER TABLE testé avant
application). Le serveur applique aussi cette migration au démarrage
(`_ensure_epreuve_files_sujet_index` dans main.py) — ce script permet de
la déclencher hors du cycle de vie de l'API.

Usage : cd backend && python -m app.scripts_dev.migrate_multi_sujets
"""

from __future__ import annotations

from sqlalchemy import inspect, text

from app.core.logging_config import get_logger
from app.db import engine

log = get_logger("migrate_multi_sujets")


def _ensure_sujet_index_column() -> bool:
    """ALTER TABLE ADD COLUMN si la colonne est absente."""
    insp = inspect(engine)
    if "epreuve_files" not in insp.get_table_names():
        return False
    existing = {c["name"] for c in insp.get_columns("epreuve_files")}
    if "sujet_index" in existing:
        return False
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE epreuve_files ADD COLUMN sujet_index INTEGER NOT NULL DEFAULT 0"))
    log.info("Colonne ajoutée: epreuve_files.sujet_index (DEFAULT 0)")
    return True


def main() -> None:
    added = _ensure_sujet_index_column()
    log.info(
        "Migration multi-sujets terminée — %s",
        "colonne epreuve_files.sujet_index ajoutée" if added else "ras (colonne déjà présente)",
    )


if __name__ == "__main__":
    main()