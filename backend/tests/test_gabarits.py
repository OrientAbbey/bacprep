"""Gabarits paramétrés : évaluateur à liste blanche, mise en forme, tirage déterministe, schéma, rapport de validation, chargement.

Rien n'est exécuté : ces tests vérifient surtout que ce qui est hostile ou faux est REFUSÉ, et que les valeurs sont exactes (fractions)."""
from __future__ import annotations

import copy
import json
from fractions import Fraction

import pytest

from app.core import gabarits as g


def ev(expression: str, **valeurs):
    return g._eval(g._compiler(expression), {k: Fraction(v) for k, v in valeurs.items()})


# --- Évaluateur : valeurs exactes -----------------------------------------------------------------------------------------

@pytest.mark.parametrize("expr,attendu", [
    ("1/3 + 1/6", Fraction(1, 2)), ("2 + 3*4", 14), ("(2 + 3)*4", 20), ("-2**2", -4), ("2**-2", Fraction(1, 4)), ("7 // 2", 3), ("-7 // 2", -4),
    ("7 % 3", 1), ("-7 % 3", 2), ("0.1 + 0.2", Fraction(3, 10)), ("abs(-5)", 5), ("min(3, 1, 2)", 1), ("max(3, 1, 2)", 3),
    ("pgcd(12, 18)", 6), ("ppcm(4, 6)", 12), ("reste(17, 5)", 2), ("quotient(17, 5)", 3), ("sgn(-9)", -1), ("sgn(0)", 0), ("ent(7/2)", 3), ("ent(-7/2)", -4),
    ("racine(49)", 7), ("racine(9/4)", Fraction(3, 2)), ("est_carre(16)", 1), ("est_carre(15)", 0), ("est_carre(-4)", 0), ("comb(5, 2)", 10), ("fact(5)", 120),
    ("arrondi(2.675, 2)", Fraction(268, 100)), ("arrondi(7/2)", 4), ("arrondi(-7/2)", -4),
])
def test_valeurs_exactes(expr, attendu):
    assert ev(expr) == attendu


def test_comparaisons_et_logique():
    assert ev("1 < 2 < 3") is True and ev("1 < 3 < 2") is False
    assert ev("a != 0 and a < 5", a=3) is True and ev("a == 0 or a > 5", a=3) is False
    assert ev("not (a == 3)", a=3) is False


def test_les_fractions_restent_exactes_sans_flottant():
    assert ev("a/b + c/d", a=1, b=3, c=1, d=7) == Fraction(10, 21)
    assert ev("(1/10)*3") == Fraction(3, 10)


# --- Évaluateur : refus ---------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("hostile", [
    "__import__('os').system('id')", "open('/etc/passwd')", "eval('1')", "exec('x=1')", "().__class__", "a.__class__", "a.b", "[1, 2, 3]", "(1, 2)", "{1: 2}",
    "{1, 2}", "a[0]", "lambda: 1", "[x for x in range(3)]", "a if a else 2", "1j", "True", "None", "'texte'.upper()", "a := 3", "*a", "f'{a}'", "...",
    "1e999", "abs(a, key=1)", "print(1)", "getattr(a, 'x')", "min.__call__(1)", "a @ a", "a & 1", "a | 1", "a ^ 1", "a << 2", "~a",
])
def test_constructions_hostiles_refusees(hostile):
    with pytest.raises(g.GabaritError):
        g._eval(g._compiler(hostile), {"a": Fraction(1)})


@pytest.mark.parametrize("expr", ["1/0", "a % 0", "a // 0", "reste(3, 0)", "quotient(3, 0)", "0**-1", "2**9", "2**-9", "2**(1/2)", "9**8**2", "racine(2)", "racine(-4)",
                                  "comb(70, 2)", "comb(2, 5)", "fact(16)", "fact(-1)", "arrondi(1, 20)", "pgcd(1/2, 3)", "abs()", "min()", "tex('x')", "poly('y', 'z')",
                                  "dec(1, 99)", "tex(1, 2)", "unknown(3)", "1 + undefined_name", "'a' + 1", "1 + abs"])
def test_calculs_impossibles_refuses(expr):
    with pytest.raises(g.GabaritError):
        ev(expr, a=3)


def test_bornes_de_taille():
    with pytest.raises(g.GabaritError, match="trop long"):
        g._compiler("1" + " + 1" * 100)
    with pytest.raises(g.GabaritError, match="trop"):
        g._compiler("+".join(["1"] * 80))
    with pytest.raises(g.GabaritError, match="trop grande"):
        ev("99999999999 * 99999999999")
    with pytest.raises(g.GabaritError, match="trop grande"):
        ev("(a**8)*(a**8)", a=99999)


def test_expression_vide_ou_illisible():
    for mauvaise in ("", "   ", "1 +", "((", "a b"):
        with pytest.raises(g.GabaritError):
            g._compiler(mauvaise)
    with pytest.raises(g.GabaritError):
        g._compiler(None)  # type: ignore[arg-type]


# --- Mise en forme --------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("expr,attendu", [
    ("tex(3)", "3"), ("tex(-3)", "-3"), ("tex(3/4)", r"\frac{3}{4}"), ("tex(-3/4)", r"-\frac{3}{4}"), ("tex(6/3)", "2"),
    ("par(-3)", "(-3)"), ("par(3)", "3"), ("par(-1/2)", r"(-\frac{1}{2})"),
    ("plus(3)", "+ 3"), ("plus(-3)", "- 3"), ("plus(1/2)", r"+ \frac{1}{2}"), ("plus(0)", "+ 0"),
    ("dec(3.14159, 2)", "3{,}14"), ("dec(2.675, 2)", "2{,}68"), ("dec(5, 1)", "5{,}0"), ("dec(5, 0)", "5"), ("dec(-0.001, 2)", "0{,}00"), ("dec(1/3, 3)", "0{,}333"),
    ("dec(7)", "7{,}00"),
    ("poly(2, -1, 0, 1)", "2x^{3} - x^{2} + 1"), ("poly(1, 0, -4)", "x^{2} - 4"), ("poly(-1, 2)", "-x + 2"), ("poly(0, 0, 5)", "5"), ("poly(0, 0, 0)", "0"),
    ("poly(-3, 0, 0, 0)", "-3x^{3}"), ("poly(1, 1)", "x + 1"), ("poly(1/2, -1/3)", r"\frac{1}{2}x - \frac{1}{3}"), ("poly(2, 3, 'n')", "2n + 3"), ("poly(1, -1, 1, 'x')", "x^{2} - x + 1"),
    ("cplx(3, -1)", "3 - i"), ("cplx(0, 2)", "2i"), ("cplx(-4, 0)", "-4"), ("cplx(0, -1)", "-i"), ("cplx(0, 0)", "0"), ("cplx(1, 1)", "1 + i"), ("cplx(-2, -5)", "-2 - 5i"),
    ("rac(16)", "4"), ("rac(12)", r"\sqrt{12}"), ("rac(0)", "0"),
])
def test_mise_en_forme(expr, attendu):
    assert ev(expr) == attendu


@pytest.mark.parametrize("expr,attendu", [
    ("milliers(15000)", "15\u202f000"), ("milliers(500)", "500"), ("milliers(1234567)", "1\u202f234\u202f567"), ("milliers(-2000)", "-2\u202f000"), ("milliers(0)", "0"),
    ("milliers_tex(15000)", "15\\,000"), ("milliers_tex(999)", "999"), ("milliers_tex(1000000)", "1\\,000\\,000"),
    ("decimal(5/4)", "1{,}25"), ("decimal(3)", "3"), ("decimal(1/8)", "0{,}125"), ("decimal(-1/8)", "-0{,}125"), ("decimal(1/20)", "0{,}05"), ("decimal(14.625)", "14{,}625"),
    ("decimal(0)", "0"), ("decimal(10)", "10"), ("decimal(7/2)", "3{,}5"), ("decimal(100/4)", "25"),
    ('texte(0, "Mballa", "Fotso")', "Mballa"), ('texte(1, "Mballa", "Fotso")', "Fotso"), ('texte(a, "x", "y", "z")', "z"),
])
def test_milliers_decimal_texte(expr, attendu):
    assert ev(expr, a=2) == attendu


@pytest.mark.parametrize("mauvais", ["decimal(1/3)", "decimal(2/7)", "milliers(1/2)", "milliers_tex(0.5)", "texte(3, 'a', 'b', 'c')", "texte(-1, 'a', 'b')", "texte(0)", "texte(0, 1)",
                                     "texte(1/2, 'a', 'b')", "texte('a', 'b')", "decimal(1/2**20)"])
def test_milliers_decimal_texte_refus(mauvais):
    with pytest.raises(g.GabaritError):
        ev(mauvais)


def test_les_classes_doivent_etre_des_codes_du_referentiel():
    for ok in (["terminale"], ["1ere", "2nde"], ["3e"]):
        g.Gabarit(faux(classes=ok))
    for mauvais in (["première"], ["seconde"], ["Terminale"], ["terminale", "inconnue"], ["1ère"]):
        with pytest.raises(g.GabaritError, match="codes inconnus"):
            g.Gabarit(faux(classes=mauvais))


def test_condition_si():
    assert ev('si(a > 2, "grand", "petit")', a=3) == "grand" and ev('si(a > 2, "grand", "petit")', a=1) == "petit"
    assert ev('si(a, "oui", "non")', a=0) == "non" and ev('si(a, "oui", "non")', a=5) == "oui"
    assert isinstance(ev('si(1 == 1, "x", "y")'), g.Texte)
    for mauvais in ('si(1 == 1, "x")', 'si(1 == 1, 2, "y")', 'si("a", "x", "y")', 'si(1 == 1, "x", "y", "z")'):
        with pytest.raises(g.GabaritError):
            ev(mauvais)


def test_une_mise_en_forme_est_un_texte_pas_un_nombre():
    with pytest.raises(g.GabaritError):
        ev("tex(2) + 1")
    assert isinstance(ev("tex(2)"), g.Texte)


# --- Schéma d'un gabarit --------------------------------------------------------------------------------------------------

BASE = {
    "id": "exemple-test", "titre": "Titre", "matiere": "Mathématiques", "classes": ["terminale"], "chapitre": "Chap", "difficulte": 1,
    "variables": {"a": {"entier": [1, 5]}, "b": {"entier": [-9, 9], "non_nul": True}},
    "calculs": {"s": "a + b"},
    "contraintes": ["s != 0"],
    "enonce": "Soit $f(x) = {{poly(a, b)}}$.",
    "questions": [{"enonce": "Calculer $f({{a}})$.", "reponse": "${{a*a + b}}$", "etapes": "On remplace : ${{a}} \\times {{a}} {{plus(b)}}$.", "points": 1.5}],
}


def faux(**modif):
    brut = copy.deepcopy(BASE)
    for cle, val in modif.items():
        if val is None:
            brut.pop(cle, None)
        else:
            brut[cle] = val
    return brut


def test_gabarit_valide():
    gab = g.Gabarit(BASE)
    assert (gab.id, gab.total_points, gab.difficulte) == ("exemple-test", Fraction(3, 2), 1)
    assert gab.resume() == {"id": "exemple-test", "titre": "Titre", "matiere": "Mathématiques", "classes": ["terminale"], "chapitre": "Chap", "difficulte": 1, "total_points": 1.5}


@pytest.mark.parametrize("modif,fragment", [
    ({"id": None}, "id"), ({"id": "Mauvais Id"}, "id invalide"), ({"id": "ab"}, "id invalide"), ({"titre": ""}, "titre"), ({"matiere": None}, "matiere"),
    ({"chapitre": "  "}, "chapitre"), ({"classes": []}, "classes"), ({"classes": "terminale"}, "classes"), ({"classes": [""]}, "classes"),
    ({"difficulte": 4}, "difficulte"), ({"difficulte": True}, "difficulte"), ({"variables": {}}, "variables"), ({"variables": None}, "variables"),
    ({"variables": {"A": {"entier": [1, 2]}}}, "nom de variable"), ({"variables": {"tex": {"entier": [1, 2]}}}, "réservé"),
    ({"variables": {"a": {"entier": [1, 2], "choix": [1]}}}, "exactement un type"), ({"variables": {"a": {}}}, "exactement un type"),
    ({"variables": {"a": {"entier": [5, 1]}}}, "min ≤ max"), ({"variables": {"a": {"entier": [1]}}}, "min, max"), ({"variables": {"a": {"entier": [1.5, 2]}}}, "min, max"),
    ({"variables": {"a": {"entier": [1, 9999999]}}}, "trop grand"), ({"variables": {"a": {"entier": [1, 2], "sauf": ["x"]}}}, "sauf"),
    ({"variables": {"a": {"entier": [1, 1], "sauf": [1]}}}, "aucune valeur"), ({"variables": {"a": {"choix": []}}}, "choix"), ({"variables": {"a": {"choix": ["x"]}}}, "nombre attendu"),
    ({"variables": {"a": {"decimal": [0, 1]}}}, "decimal"), ({"variables": {"a": {"decimal": [0, 1, 0]}}}, "pas > 0"),
    ({"variables": {f"v{i}": {"entier": [1, 2]} for i in range(20)}}, "variables"),
    ({"calculs": {"a": "1"}}, "invalide"), ({"calculs": {"c": "zz + 1"}}, "inconnue"), ({"calculs": {"c": "d + 1", "d": "1"}}, "pas encore définie"), ({"calculs": ["x"]}, "calculs"),
    ({"calculs": {"c": "__import__('os')"}}, "interdit"), ({"contraintes": ["zz > 0"]}, "inconnue"), ({"contraintes": "a"}, "contraintes"),
    ({"enonce": "Soit {{zz}}"}, "inconnue"), ({"enonce": "Soit {{a"}, "doublées"), ({"enonce": "a }} b {{a}}"}, "doublées"), ({"enonce": ""}, "enonce"), ({"enonce": "{{ a.b }}"}, "interdite"),
    ({"questions": []}, "questions"), ({"questions": None}, "questions"), ({"questions": ["x"]}, "objet"),
    ({"questions": [{"enonce": "e", "reponse": "r", "etapes": "t", "points": 0}]}, "points"),
    ({"questions": [{"enonce": "e", "reponse": "r", "etapes": "t", "points": 0.3}]}, "quarts"),
    ({"questions": [{"enonce": "e", "reponse": "r", "etapes": "t", "points": "1"}]}, "nombre attendu"),
    ({"questions": [{"enonce": "e", "reponse": "r", "points": 1}]}, "etapes"),
    ({"questions": [{"enonce": "e", "reponse": "r", "etapes": "t", "points": 1}] * 13}, "questions"),
])
def test_gabarits_invalides_refuses(modif, fragment):
    with pytest.raises(g.GabaritError) as exc:
        g.Gabarit(faux(**modif))
    assert fragment in str(exc.value)


def test_un_gabarit_n_est_pas_autre_chose_qu_un_objet():
    for pas_un_objet in ([], "x", 3, None):
        with pytest.raises(g.GabaritError):
            g.Gabarit(pas_un_objet)  # type: ignore[arg-type]


# --- Tirage ---------------------------------------------------------------------------------------------------------------

def test_tirage_deterministe_et_varie():
    gab = g.Gabarit(BASE)
    assert gab.tirer(42) == gab.tirer(42) and gab.instancier(42) == gab.instancier(42)
    assert len({tuple(sorted(gab.tirer(s).items())) for s in range(50)}) > 10


def test_contraintes_sauf_et_non_nul_toujours_respectes():
    gab = g.Gabarit(faux(variables={"a": {"entier": [1, 3], "sauf": [2]}, "b": {"entier": [-2, 2], "non_nul": True}}, contraintes=["a + b != 0"]))
    for s in range(300):
        env = gab.tirer(s)
        assert env["a"] in (1, 3) and env["b"] != 0 and env["a"] + env["b"] != 0 and env["s"] == env["a"] + env["b"]


def test_tirage_impossible():
    with pytest.raises(g.GabaritError, match="aucun tirage"):
        g.Gabarit(faux(contraintes=["a > 100"])).tirer(1)


def test_division_par_zero_dans_un_calcul_refait_le_tirage():
    gab = g.Gabarit(faux(variables={"b": {"entier": [0, 3]}}, calculs={"inv": "1/b"}, contraintes=["b > -1"], enonce="{{tex(inv)}}", questions=[
        {"enonce": "e", "reponse": "{{tex(inv)}}", "etapes": "t", "points": 1}]))
    assert all(gab.tirer(s)["b"] != 0 for s in range(100))
    with pytest.raises(g.GabaritError):
        g.Gabarit(faux(variables={"b": {"entier": [0, 0]}}, calculs={"inv": "1/b"}, contraintes=["b > -1"], enonce="{{tex(inv)}}", questions=[
            {"enonce": "e", "reponse": "r", "etapes": "t", "points": 1}])).tirer(1)


def test_decimal_par_pas():
    gab = g.Gabarit(faux(variables={"p": {"decimal": [0.5, 2.5, 0.5]}}, calculs={}, contraintes=[], enonce="{{dec(p, 1)}}",
                         questions=[{"enonce": "e", "reponse": "r", "etapes": "t", "points": 1}]))
    assert {gab.tirer(s)["p"] for s in range(100)} == {Fraction(1, 2), Fraction(1), Fraction(3, 2), Fraction(2), Fraction(5, 2)}


@pytest.mark.parametrize("graine", [-1, 2**31, 1.5, "3", None, True])
def test_graine_invalide(graine):
    with pytest.raises(g.GabaritError, match="graine"):
        g.Gabarit(BASE).tirer(graine)


def test_instance_et_vues():
    gab = g.Gabarit(BASE)
    inst = gab.instancier(7)
    env = gab.tirer(7)
    assert inst["enonce"] == f"Soit $f(x) = {g._poly(env['a'], env['b'])}$."
    assert inst["questions"] == [{"enonce": f"Calculer $f({env['a']})$.", "points": 1.5}] and inst["total_points"] == 1.5
    assert inst["corrections"][0]["reponse"] == f"${env['a'] * env['a'] + env['b']}$"
    eleve = g.vue_eleve(inst)
    assert set(eleve) == {"id", "titre", "graine", "enonce", "questions", "total_points"}
    assert "reponse" not in json.dumps(eleve) and str(env["a"] * env["a"] + env["b"]) not in json.dumps(eleve["questions"])  # aucune réponse dans la vue élève
    assert g.vue_correction(inst) == {"id": "exemple-test", "graine": 7, "corrections": inst["corrections"]}


# --- Rapport de validation ------------------------------------------------------------------------------------------------

def test_rapport_gabarit_correct():
    r = g.rapport_validation(g.Gabarit(BASE), 100)
    assert r["ok"] and r["echecs"] == 0 and r["defauts"] == 0 and r["enonces_distincts"] > 10 and r["avertissements"] == []


def test_rapport_detecte_une_erreur_de_rendu():
    cassee = faux(variables={"b": {"entier": [1, 3]}}, calculs={}, contraintes=[], enonce="{{tex(1/(b-2))}}",
                  questions=[{"enonce": "e", "reponse": "r", "etapes": "t", "points": 1}])
    r = g.rapport_validation(g.Gabarit(cassee), 60)
    assert not r["ok"] and r["echecs"] > 0 and "division par zéro" in r["exemple_erreur"]


def test_rapport_detecte_un_defaut_de_texte():
    r = g.rapport_validation(g.Gabarit(faux(enonce="Voir None ici {{a}}")), 20)
    assert not r["ok"] and r["defauts"] == 20 and "None" in r["exemple_erreur"]


def test_rapport_avertit_si_peu_de_variete():
    pauvre = faux(variables={"a": {"choix": [1, 2]}}, calculs={}, contraintes=[], enonce="{{a}}", questions=[{"enonce": "e", "reponse": "r", "etapes": "t", "points": 1}])
    r = g.rapport_validation(g.Gabarit(pauvre), 50)
    assert r["ok"] and r["enonces_distincts"] == 2 and "peu de variété" in r["avertissements"][0]


# --- Hash et chargement ---------------------------------------------------------------------------------------------------

def test_hash_stable_et_sensible():
    h = g.Gabarit(BASE).hash
    assert h == g.Gabarit(json.loads(json.dumps(BASE, sort_keys=False))).hash == g.Gabarit(dict(reversed(list(BASE.items())))).hash
    assert h != g.Gabarit(faux(titre="Autre titre")).hash
    assert h != g.Gabarit(faux(enonce="Soit {{a}}")).hash


def test_chargement_du_dossier(tmp_path):
    (tmp_path / "exemple-test.json").write_text(json.dumps(BASE), encoding="utf-8")
    (tmp_path / "casse.json").write_text("{pas du json", encoding="utf-8")
    (tmp_path / "autre-nom.json").write_text(json.dumps(BASE), encoding="utf-8")  # id ≠ nom de fichier
    (tmp_path / "invalide.json").write_text(json.dumps(faux(id="invalide", titre="")), encoding="utf-8")
    valides, erreurs = g.charger_dossier(tmp_path)
    assert list(valides) == ["exemple-test"]
    assert set(erreurs) == {"casse.json", "autre-nom.json", "invalide.json"}
    assert "nom du fichier" in erreurs["autre-nom.json"] and "titre" in erreurs["invalide.json"]
