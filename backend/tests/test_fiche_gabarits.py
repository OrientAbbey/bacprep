"""Fiche de relecture des gabarits (scripts_dev/fiche_gabarits.py) : une ligne par gabarit, colonnes de saisie vides, couverture exacte."""
from __future__ import annotations

import csv
import importlib.util
import sys
from pathlib import Path

import pytest

from app.core import gabarits as g

_SPEC = importlib.util.spec_from_file_location("fiche_gabarits", Path(__file__).resolve().parent.parent / "scripts_dev" / "fiche_gabarits.py")
fiche = importlib.util.module_from_spec(_SPEC)
sys.modules["fiche_gabarits"] = fiche
_SPEC.loader.exec_module(fiche)


def test_une_ligne_par_gabarit_charge():
    rows = fiche.lignes()
    valides, _ = g.charger_dossier()
    assert sorted(r["id"] for r in rows) == sorted(valides) and len(rows) >= 19
    for r in rows:
        gab = valides[r["id"]]
        assert (r["titre"], r["matiere"], r["chapitre"], r["difficulte"]) == (gab.titre, gab.matiere, gab.chapitre, gab.difficulte)
        assert r["classes"] == ", ".join(gab.classes)
        assert all(r[c] == "" for c in fiche.COLONNES_SAISIE), "les colonnes de décision doivent partir vides"


def test_csv_pour_excel_francais(tmp_path):
    chemin = tmp_path / "fiche.csv"
    fiche.ecrire_csv(chemin)
    brut = chemin.read_bytes()
    assert brut.startswith(b"\xef\xbb\xbf") and brut.split(b"\n")[0].count(b";") == len(fiche.COLONNES) - 1
    with chemin.open(encoding="utf-8-sig", newline="") as f:
        lus = list(csv.DictReader(f, delimiter=";"))
    assert list(lus[0]) == fiche.COLONNES and len(lus) == len(fiche.lignes())
    assert all(r["decision"] == "" for r in lus)
    assert any("Dériver" in r["titre"] for r in lus) and any("2nde" in r["classes"] for r in lus)  # accents et virgules dans les champs conservés


def test_colonnes_de_saisie_documentees():
    assert set(fiche.COLONNES_SAISIE) == set(fiche.AIDE) and set(fiche.DECISIONS) == {"valider", "modifier", "écarter"}


def test_couverture_exacte():
    rows = fiche.lignes()
    tableau = fiche.couverture(rows)
    assert tableau.splitlines()[0].startswith("| Matière | Chapitre")
    # chaque chapitre apparaît une fois, avec le bon nombre d'exercices et l'union des classes
    for chapitre in {(r["matiere"], r["chapitre"]) for r in rows}:
        exos = [r for r in rows if (r["matiere"], r["chapitre"]) == chapitre]
        classes = ", ".join(sorted({c for e in exos for c in e["classes"].split(", ")}))
        assert f"| {chapitre[0]} | {chapitre[1]} | {len(exos)} | {classes} |" in tableau
    assert sum(int(ligne.split("|")[3]) for ligne in tableau.splitlines()[2:]) == len(rows)  # aucun exercice oublié ni compté deux fois


def test_chapitres_coherents_sans_doublon_de_nom():
    """Deux noms pour le même chapitre brouilleraient la lecture de la couverture : on garde un seul libellé par notion."""
    chapitres = {r["chapitre"] for r in fiche.lignes()}
    assert "Dérivation" not in chapitres and "Dérivabilité et étude de fonctions" in chapitres


def test_cli(tmp_path, capsys):
    assert fiche.main([str(tmp_path / "f.csv")]) == 0
    assert "exercices écrits" in capsys.readouterr().out and (tmp_path / "f.csv").exists()
    assert fiche.main([]) == 2


def test_couverture_fait_l_union_des_classes_de_plusieurs_exercices():
    """Données fabriquées : avec les vrais gabarits, tous les exercices d'un même chapitre visent les mêmes classes et l'union ne se distingue pas du premier."""
    base = {"matiere": "Maths", "chapitre": "Suites", "titre": "t", "difficulte": 1, "points": "1"}
    rows = [{**base, "id": "a", "classes": "terminale"}, {**base, "id": "b", "classes": "1ere, 2nde"}, {**base, "id": "c", "classes": "terminale"}]
    assert "| Maths | Suites | 3 | 1ere, 2nde, terminale |" in fiche.couverture(rows)


def test_la_fiche_refuse_des_fichiers_de_gabarits_invalides(monkeypatch):
    monkeypatch.setattr(g, "charger_dossier", lambda *a, **k: ({}, {"casse.json": "id invalide"}))
    with pytest.raises(SystemExit, match="invalides"):
        fiche.lignes()
