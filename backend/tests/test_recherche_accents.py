"""Recherche globale insensible aux accents et à la casse."""
from __future__ import annotations


def test_recherche_sans_accents(eleve, epreuve_gratuite):
    r = eleve.get("/api/epreuves", params={"q": "mathematiques"})
    assert r.status_code == 200, r.text
    assert any(e["id"] == epreuve_gratuite for e in r.json()), r.json()
    r = eleve.get("/api/epreuves", params={"q": "MATHÉMATIQUES"})
    assert any(e["id"] == epreuve_gratuite for e in r.json())


def test_unaccent_actif_sur_postgres(client):
    """Sur PostgreSQL, l'extension est bien activée (sinon la recherche resterait
    sensible aux accents). Sans objet sous SQLite (fonction LOWER() remplacée)."""
    import pytest

    from app.core import textsearch
    from app.db import IS_SQLITE

    if IS_SQLITE:
        pytest.skip("SQLite : pas d'extension unaccent")
    assert textsearch._UNACCENT is True
