"""Recherche texte insensible à la casse ET aux accents, sur les deux bases.

SQLite : la fonction LOWER() est remplacée à la connexion (voir db.py) par une
version qui retire aussi les accents. PostgreSQL : extension `unaccent`
(`activer_unaccent`, appelée au démarrage ; sans elle, repli sur `ilike`)."""
from __future__ import annotations

from sqlalchemy import func, text

from ..db import _fold_for_search, engine
from .logging_config import get_logger

log = get_logger("textsearch")
_UNACCENT = False


def activer_unaccent() -> None:
    global _UNACCENT
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.begin() as conn:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS unaccent"))
        _UNACCENT = True
    except Exception:  # privilèges insuffisants : la recherche reste sensible aux accents
        log.warning("Extension unaccent indisponible : recherche sensible aux accents")


def contient(colonne, q: str):
    """Condition « la colonne contient q » (casse et accents ignorés)."""
    if _UNACCENT:
        return func.lower(func.unaccent(colonne)).like(f"%{_fold_for_search(q)}%")
    return colonne.ilike(f"%{q}%")
