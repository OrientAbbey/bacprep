"""Gabarits d'exemple livrés (app/gabarits/) : chargés, rendus sans défaut sur 200 graines, et vérifiés par recalcul INDÉPENDANT (SymPy, énumération).

Les gabarits d'exemple sont écrits par une IA : ces tests prouvent que leurs MATHS sont justes (recalcul indépendant), pas que leur énoncé est adapté au
programme camerounais ni bien formulé : c'est la validation par un enseignant (statut « validé ») qui le dit."""
from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("sympy")

from app.core import gabarits as g  # noqa: E402

_SPEC = importlib.util.spec_from_file_location("verif_gabarits", Path(__file__).resolve().parent.parent / "scripts_dev" / "verif_gabarits.py")
verif = importlib.util.module_from_spec(_SPEC)
sys.modules["verif_gabarits"] = verif
_SPEC.loader.exec_module(verif)

VALIDES, ERREURS = g.charger_dossier()
IDS = sorted(VALIDES)


def test_les_exemples_se_chargent():
    assert ERREURS == {}
    assert len(IDS) >= 19 and {"derivee-polynome-degre-3", "association-resistances-loi-ohm"} <= set(IDS)
    assert {VALIDES[i].matiere for i in IDS} == {"Mathématiques", "Physique-Chimie"}


@pytest.mark.parametrize("gid", IDS)
def test_rendu_sans_defaut_sur_200_graines(gid):
    r = g.rapport_validation(VALIDES[gid], 200)
    assert r["ok"], r
    assert r["enonces_distincts"] >= 40, r  # assez de variété pour s'entraîner


@pytest.mark.parametrize("gid", IDS)
def test_verification_independante(gid):
    erreurs = [e for graine in range(80) for e in verif.verifier(VALIDES[gid], graine)]
    assert erreurs == [], erreurs[:3]


@pytest.mark.parametrize("gid", IDS)
def test_la_vue_eleve_ne_contient_aucune_reponse(gid):
    gab = VALIDES[gid]
    for graine in range(30):
        inst = gab.instancier(graine)
        eleve = json.dumps(g.vue_eleve(inst), ensure_ascii=False)
        # les méthodes (longues, uniques) ne doivent jamais figurer ; une réponse courte comme « $12$ » peut légitimement coïncider avec une donnée de l'énoncé
        assert all(c["etapes"] not in eleve and (len(c["reponse"]) < 20 or c["reponse"] not in eleve) for c in inst["corrections"])
        assert "etapes" not in eleve and "corrections" not in eleve and '"reponse"' not in eleve


@pytest.mark.parametrize("gid", IDS)
def test_barème_et_structure(gid):
    gab = VALIDES[gid]
    assert 2 <= len(gab.questions) <= 4 and gab.total_points > 0 and gab.difficulte in (1, 2, 3)
    inst = gab.instancier(3)
    assert inst["total_points"] == sum(q["points"] for q in inst["questions"])
    assert all(q["enonce"].strip() and c["reponse"].strip() and c["etapes"].strip() for q, c in zip(inst["questions"], inst["corrections"], strict=True))


# --- La vérification sait ÉCHOUER : une formule fausse doit être détectée --------------------------------------------------

FORMULES_FAUSSES = [
    ("derivee-polynome-degre-3", "d2", "3*b"), ("derivee-polynome-degre-3", "fp0", "3*a*x0**2 + b*x0 + c"),
    ("equation-second-degre-racines-entieres", "delta", "b*b + 4*a*c"),
    ("suite-arithmetique", "somme", "(n + 1)*(u0 + n*r)/2"), ("suite-arithmetique", "un", "u0 + (n + 1)*r"),
    ("suite-geometrique", "un", "u0*q**(n + 1)"), ("suite-geometrique", "somme", "u0*(q**n - 1)/(q - 1)"),
    ("limite-fraction-rationnelle", "lim", "b/d"), ("integrale-polynome", "vi", "a*k**3/3 + b*k**2/2"),
    ("integrale-polynome", "pb", "b/3"),
    ("probabilite-urne", "pm", "same/(pairs + 1)"), ("probabilite-urne", "prv", "(r + v)/pairs"), ("probabilite-urne", "pr", "r/(n + 1)"),
    ("nombres-complexes-produit-module", "pr", "a*c + b*d"), ("nombres-complexes-produit-module", "h", "m*m + nn"),
    ("droite-deux-points", "p", "ya + m*xa"), ("mouvement-rectiligne-uniformement-varie", "dist", "v0*t + acc*t*t"),
    ("mouvement-rectiligne-uniformement-varie", "vkmh", "v*3"), ("association-resistances-loi-ohm", "rp", "r1*r2/(r1 - r2 + 100)"),
    ("association-resistances-loi-ohm", "i", "u/r1"),
    ("tontine-cotisation-croissante", "un", "u1 + n*r"), ("tontine-cotisation-croissante", "total", "n*(u1 + un)"),
    ("placement-interets-composes", "q", "1 + t/10"), ("placement-interets-composes", "cn", "c0*q*n"),
    ("benefice-maximal-commerce", "bmax", "a*xs*xs"), ("benefice-maximal-commerce", "d0", "a*xs"),
    ("delegues-classe-probabilites", "p2f", "pf2/(pairs + 1)"), ("delegues-classe-probabilites", "pau", "pg2/pairs"),
    ("moyenne-ponderee-bulletin", "pts", "cm*nm + cf*nf + ca*na"), ("moyenne-ponderee-bulletin", "moy", "pts/(coefs - 1)"),
    ("facture-electricite-energie", "ej", "pw*h/100"), ("facture-electricite-energie", "cout", "em*tarif + 1000"),
    ("solution-nacl-concentration-dilution", "m", "58*k"), ("solution-nacl-concentration-dilution", "cf", "c*v1/v0"),
    ("chute-libre-puits", "h", "10*t*t"), ("chute-libre-puits", "vk", "v*3"),
]


def _detecte(raw: dict, graines: int = 40) -> bool:
    try:
        gab = g.Gabarit(raw)
    except g.GabaritError:
        return True
    for graine in range(graines):
        try:
            if verif.verifier(gab, graine):
                return True
        except g.GabaritError:
            return True
    return False


@pytest.mark.parametrize("gid,calcul,fausse", FORMULES_FAUSSES)
def test_une_formule_fausse_est_detectee(gid, calcul, fausse):
    raw = copy.deepcopy(VALIDES[gid].brut)
    assert calcul in raw["calculs"]
    assert not _detecte(VALIDES[gid].brut, 40), "le gabarit d'origine doit être cohérent"
    raw["calculs"][calcul] = fausse
    assert _detecte(raw), f"{gid}.{calcul} = {fausse} n'a pas été repéré"


def test_une_reponse_qui_n_affiche_pas_son_calcul_est_detectee():
    raw = copy.deepcopy(VALIDES["derivee-polynome-degre-3"].brut)
    raw["questions"][1]["reponse"] = raw["questions"][1]["reponse"].replace("{{fp0}}", "{{f0}}")
    assert _detecte(raw)


def test_un_gabarit_sans_verification_est_refuse():
    raw = copy.deepcopy(VALIDES["suite-arithmetique"].brut)
    raw["id"] = "gabarit-inconnu-du-verificateur"
    assert verif.verifier(g.Gabarit(raw), 0) == ["aucune vérification indépendante n'existe pour ce gabarit"]
