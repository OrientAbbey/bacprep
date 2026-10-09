"""Normalisation de DATABASE_URL : toutes les formes PostgreSQL passent par psycopg v3."""
from __future__ import annotations

import pytest

from app.db import normaliser_url


@pytest.mark.parametrize("entree", [
    "postgresql://u:p@h:6543/postgres",            # forme donnée par Supabase / Render
    "postgres://u:p@h:6543/postgres",              # ancienne forme (Heroku, anciens Render)
    "postgresql+psycopg2://u:p@h:6543/postgres",   # ancien pilote, DATABASE_URL déjà saisi
    "postgresql+psycopg://u:p@h:6543/postgres",    # déjà correcte
])
def test_toute_forme_postgresql_passe_par_psycopg3(entree):
    assert normaliser_url(entree) == "postgresql+psycopg://u:p@h:6543/postgres"


def test_sqlite_et_urls_inconnues_inchangees():
    assert normaliser_url("sqlite:///x.db") == "sqlite:///x.db"
    assert normaliser_url("mysql://u@h/db") == "mysql://u@h/db"


def test_le_moteur_se_construit_avec_chaque_forme():
    """Garde contre la régression SQLAlchemy 2.1 (« No module named 'psycopg' »)."""
    from sqlalchemy import create_engine

    for url in ("postgresql://u:p@h/db", "postgres://u:p@h/db", "postgresql+psycopg2://u:p@h/db"):
        assert create_engine(normaliser_url(url)).dialect.driver == "psycopg"
