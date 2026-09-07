"""Parsing heuristique d'import (purement unitaire : ni base ni stockage)."""
from __future__ import annotations

from pathlib import Path

from app.core import import_parsing


def rel(*parts: str) -> Path:
    return Path(*parts)


def test_chemin_complet(tmp_path):
    meta = import_parsing.parse_path(
        tmp_path / "2023" / "terminale" / "Mathématiques" / "bac-D-sujet.md", tmp_path
    )
    assert meta["annee"] == "2023"
    assert meta["classe"] == "terminale"
    assert meta["matiere"] == "Mathématiques"
    assert meta["serie"] == "D"
    assert meta["evaluation"] == "BAC"
    assert meta["cible"] == "sujet"
    assert meta["manquants"] == []


def test_corrige_reconnu(tmp_path):
    meta = import_parsing.parse_path(
        tmp_path / "2022" / "1ere" / "Physique" / "probatoire-corrige.md", tmp_path
    )
    assert meta["cible"] == "corrige"
    assert meta["evaluation"] == "PROBATOIRE"
    assert meta["classe"] == "1ere"


def test_matiere_inconnue_via_segment_apres_classe(tmp_path):
    meta = import_parsing.parse_path(
        tmp_path / "2024" / "3e" / "EDHC" / "bepc-sujet.md", tmp_path
    )
    assert meta["classe"] == "3e"
    assert meta["matiere"] == "EDHC"


def test_matiere_avec_annee_en_suffixe(tmp_path):
    meta = import_parsing.parse_path(tmp_path / "maths_2023" / "sujet.md", tmp_path / "maths_2023")
    # pas d'année de dossier → manquant, mais le nom "sujet" ne donne pas de matière
    assert "annee" in meta["manquants"]


def test_racine_niveau_ignoree(tmp_path):
    meta = import_parsing.parse_path(
        tmp_path / "secondaire" / "2021" / "terminale" / "Anglais" / "bac-A-corrige.md", tmp_path
    )
    assert meta["niveau"] == "SECONDAIRE"
    assert meta["annee"] == "2021"
    assert meta["serie"] == "A"


def test_sequences(tmp_path):
    meta = import_parsing.parse_path(
        tmp_path / "2024" / "6e" / "Français" / "sequence 1 sujet.md", tmp_path
    )
    assert meta["evaluation"] == "SEQUENCE 1"
