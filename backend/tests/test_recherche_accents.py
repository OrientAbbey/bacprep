"""Recherche globale insensible aux accents et à la casse."""
from __future__ import annotations


def test_recherche_sans_accents(eleve, epreuve_gratuite):
    r = eleve.get("/api/epreuves", params={"q": "mathematiques"})
    assert r.status_code == 200, r.text
    assert any(e["id"] == epreuve_gratuite for e in r.json()), r.json()
    r = eleve.get("/api/epreuves", params={"q": "MATHÉMATIQUES"})
    assert any(e["id"] == epreuve_gratuite for e in r.json())
