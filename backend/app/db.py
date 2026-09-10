"""Database engine, session factory and filesystem paths.

Every path used anywhere in the backend (seed content, uploads, sqlite
file) is derived from BASE_DIR, which is computed from this file's own
location rather than the process current working directory. This lets
`uvicorn app.main:app` work correctly no matter which directory it is
launched from.
"""
from __future__ import annotations

import os
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy.types import DateTime, TypeDecorator

# backend/app/db.py -> backend/
BASE_DIR = Path(__file__).resolve().parent.parent

DATA_DIR = BASE_DIR / "data"
SUJETS_SEED_DIR = DATA_DIR / "epreuves" / "sujets"
CORRIGES_SEED_DIR = DATA_DIR / "epreuves" / "corriges"
# Racine du stockage objet en développement (STORAGE_BACKEND=local) — en
# production le stockage est un bucket S3-compatible et ce dossier ne sert plus.
STORAGE_LOCAL_DIR = DATA_DIR / "storage"
# Zone d'import massif : y déposer un dossier organisé {annee}/{classe}/
# {matiere}/*.md puis lancer `python -m app.scripts.importer` (ou passer par
# l'upload zip de l'interface admin, qui fait de même).
IMPORTS_DIR = DATA_DIR / "imports"
LOGS_DIR = BASE_DIR / "logs"

for d in (
    DATA_DIR,
    SUJETS_SEED_DIR,
    CORRIGES_SEED_DIR,
    STORAGE_LOCAL_DIR,
    IMPORTS_DIR,
    LOGS_DIR,
):
    d.mkdir(parents=True, exist_ok=True)

DEFAULT_SQLITE_URL = f"sqlite:///{(DATA_DIR / 'bacprep.db').as_posix()}"
DATABASE_URL = os.getenv("DATABASE_URL", DEFAULT_SQLITE_URL)

IS_SQLITE = DATABASE_URL.startswith("sqlite")

if not IS_SQLITE and "sslmode" not in DATABASE_URL:
    # Les PostgreSQL managés (Supabase en tête) refusent les connexions sans
    # chiffrement → le démarrage échouait avec « SSL required ». On force
    # sslmode=require par défaut ; un Postgres local sans SSL peut le
    # désactiver via DB_SSLMODE=disable.
    _db_sslmode = os.getenv("DB_SSLMODE", "require")
    _sep = "&" if "?" in DATABASE_URL else "?"
    DATABASE_URL = f"{DATABASE_URL}{_sep}sslmode={_db_sslmode}"


def _fold_for_search(value):
    """Normalise une chaîne pour une comparaison insensible à la casse ET
    aux accents (ex. "Éducation" et "education" doivent être considérés
    égaux). Utilisée pour remplacer LOWER() côté SQLite (voir
    `_set_sqlite_pragmas` ci-dessous) — miroir de `foldText` côté
    frontend (frontend/src/lib/text.ts) pour un comportement cohérent."""
    if not isinstance(value, str):
        return value
    decomposed = unicodedata.normalize("NFKD", value)
    without_accents = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return without_accents.lower()


if IS_SQLITE:
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
        pool_pre_ping=True,
    )

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, connection_record):  # noqa: ANN001
        """Active le mode WAL (lectures non bloquées par une écriture en
        cours), une synchronisation NORMAL (compromis performance/durabilité
        raisonnable pour ce prototype) et les clés étrangères — SQLite ne les
        active pas par défaut, contrairement à PostgreSQL.

        Enregistre aussi une fonction LOWER() Unicode-correcte ET
        insensible aux accents : la fonction LOWER intégrée à SQLite ne
        connaît que l'ASCII et laisse les caractères accentués inchangés
        (LOWER('Éducation') donne 'Éducation', pas 'éducation'). Comme
        SQLAlchemy traduit `.ilike()` en `LOWER(colonne) LIKE LOWER(motif)`
        sur ce backend, une recherche insensible à la casse sur un texte
        accentué (ex. chercher "éducation civique" pour trouver "Éducation
        Civique") échouait silencieusement. On va plus loin qu'une simple
        casse correcte : la fonction ci-dessous décompose aussi les
        caractères accentués (normalisation Unicode NFKD) et retire les
        signes diacritiques, pour qu'une recherche "education" (sans
        accent) trouve elle aussi "Éducation" — cohérent avec la même
        normalisation appliquée côté frontend pour les recherches locales
        (voir frontend/src/lib/text.ts, `foldText`)."""
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()
        dbapi_connection.create_function("LOWER", 1, _fold_for_search)
else:
    pool_size = int(os.getenv("DB_POOL_SIZE", "5"))
    max_overflow = int(os.getenv("DB_POOL_MAX_OVERFLOW", "10"))
    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,
        pool_size=pool_size,
        max_overflow=max_overflow,
    )

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


def get_db():
    """Dépendance FastAPI générateur : ouvre une session par requête, la
    ferme systématiquement (y compris en cas d'exception) via `finally`."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def utc_now() -> datetime:
    """Always timezone-aware UTC now. Never datetime.utcnow() (deprecated)."""
    return datetime.now(timezone.utc)


class UTCDateTime(TypeDecorator):
    """DateTime column type that guarantees a timezone-AWARE Python
    ``datetime`` on both write and read, regardless of the database
    backend.

    Root cause this fixes: SQLite has no native timezone-aware storage —
    even when the column is declared as ``DateTime(timezone=True)``,
    SQLite silently stores/returns a naive datetime. Any later Python-side
    arithmetic like ``utc_now() - some_naive_datetime`` then raises
    ``TypeError: can't subtract offset-naive and offset-aware datetimes``
    (this is exactly what happened in ``admin_session._is_expired``).
    PostgreSQL does not have this problem, but using this type everywhere
    keeps behaviour identical across both backends.

    Use this type in ``db_models.py`` instead of raw
    ``DateTime(timezone=True)`` for every column that will ever be
    compared/subtracted in Python (as opposed to only ever filtered via a
    SQL ``WHERE`` clause).
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):  # noqa: ANN001
        """Normalise en UTC avant écriture (traite un datetime naïf comme
        déjà en UTC plutôt que de lever une erreur)."""
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def process_result_value(self, value, dialect):  # noqa: ANN001
        """Ré-attache le fuseau UTC à la lecture si le driver l'a perdu
        (cas SQLite) — garantit un datetime toujours "aware" en sortie."""
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
