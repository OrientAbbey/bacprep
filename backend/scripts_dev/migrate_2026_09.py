"""Migration idempotente septembre 2026 — ajoute les colonnes et tables de
la vague d'améliorations (notes, signalements, profil étendu, extraits,
dimensions d'images, logs d'import, audit enrichi) puis rebâlit les données
dérivées (extraits du sujet, dimensions des images). S'exécute plusieurs
fois sans effet de bord : chaque ALTER TABLE est testé avant application.

Usage : cd backend && python -m app.scripts_dev.migrate_2026_09
"""

from __future__ import annotations

import json

from sqlalchemy import inspect, text

from app.core import extraits
from app.core.logging_config import get_logger
from app.db import SessionLocal, engine
from app.db_models import Base

log = get_logger("migrate_2026_09")

# Colonnes à ajouter si absentes : table -> [(colonne, définition SQL), ...]
COLUMNS: dict[str, list[tuple[str, str]]] = {
    "users": [
        ("niveau", "VARCHAR"),
        ("classe", "VARCHAR"),
        ("etablissement", "VARCHAR"),
        # Consentement granulaire recueilli à la connexion (NULL = pas
        # encore demandé) — remplace l'ancien consent_given_at auto-posé.
        ("consent_ia", "BOOLEAN"),
        ("consent_notes", "BOOLEAN"),
        ("consent_given_at", "TIMESTAMP"),
        # Modération back-office. NB : PostgreSQL refuse un entier (0) comme
        # défaut d'une colonne BOOLEAN — utiliser le littéral FALSE, accepté
        # par les deux SGBD (SQLite ≥ 3.23).
        ("banni", "BOOLEAN DEFAULT FALSE NOT NULL"),
        ("banni_motif", "VARCHAR"),
        # Dernière connexion persistante (survit à la déconnexion).
        ("derniere_connexion", "TIMESTAMP"),
    ],
    "epreuves": [("extrait", "VARCHAR DEFAULT '' NOT NULL")],
    "epreuve_files": [("width", "INTEGER"), ("height", "INTEGER")],
    "import_jobs": [("logs_json", "TEXT DEFAULT '[]' NOT NULL")],
    "admin_events": [("email", "VARCHAR DEFAULT '' NOT NULL"), ("details", "TEXT DEFAULT '{}' NOT NULL")],
    # Expiration glissante des sessions (last_seen rafraîchi à l'activité ;
    # issued_at borne la durée de vie maximale).
    "sessions": [("last_seen", "TIMESTAMP")],
}


def _add_missing_columns() -> list[str]:
    """ALTER TABLE ADD COLUMN pour chaque colonne manquante (inspecte le
    schéma réel — idempotent, compatible SQLite et PostgreSQL)."""
    applied = []
    insp = inspect(engine)
    with engine.begin() as conn:
        for table, columns in COLUMNS.items():
            existing = {c["name"] for c in insp.get_columns(table)}
            for name, ddl in columns:
                if name in existing:
                    continue
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
                applied.append(f"{table}.{name}")
                log.info("Colonne ajoutée: %s.%s", table, name)
    return applied


def _create_missing_tables() -> list[str]:
    """create_all des modèles (ne crée QUE les tables absentes — jamais de
    destructive). Retourne les tables réellement créées."""
    before = set(inspect(engine).get_table_names())
    Base.metadata.create_all(engine)
    created = set(inspect(engine).get_table_names()) - before
    for t in sorted(created):
        log.info("Table créée: %s", t)
    return sorted(created)


def _backfill_extraits() -> int:
    """Régénère `epreuves.extrait` depuis le sujet stocké pour toute épreuve
    dont l'extrait est vide."""
    from app.core import epreuve_files
    from app.db_models import EpreuveORM

    count = 0
    with SessionLocal() as db:
        rows = db.query(EpreuveORM).filter((EpreuveORM.extrait.is_(None)) | (EpreuveORM.extrait == "")).all()
        for e in rows:
            sujet = epreuve_files.read_document_content(db, e.id, "sujet")
            if sujet:
                e.extrait = extraits.build_extrait(sujet)
                db.add(e)
                count += 1
        db.commit()
    return count


def _backfill_dimensions() -> int:
    """Complète width/height des images existantes (lues via Pillow si
    disponible) — utile pour les vignettes du back-office."""
    from io import BytesIO

    from PIL import Image

    from app.core import epreuve_files
    from app.db_models import EpreuveFileORM

    count = 0
    storage = epreuve_files.get_storage()
    with SessionLocal() as db:
        rows = db.query(EpreuveFileORM).filter(EpreuveFileORM.format == "image").all()
        for f in rows:
            if f.width and f.height:
                continue
            try:
                data = storage.get_bytes(f.storage_key)
                img = Image.open(BytesIO(data))
                f.width, f.height = img.width, img.height
                db.add(f)
                count += 1
            except Exception as exc:
                log.warning("Dimensions illisibles pour %s : %s", f.storage_key, exc)
        db.commit()
    return count


def main() -> None:
    columns = _add_missing_columns()
    tables = _create_missing_tables()
    extraits_ok = _backfill_extraits()
    dims_ok = _backfill_dimensions()
    log.info(
        "Migration terminée — colonnes: %s ; tables: %s ; extraits régénérés: %d ; dimensions: %d",
        json.dumps(columns) if columns else "aucune (déjà à jour)",
        tables or "aucune (déjà à jour)",
        extraits_ok,
        dims_ok,
    )


if __name__ == "__main__":
    main()
