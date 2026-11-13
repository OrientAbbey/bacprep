"""Gabarits d'exercices PARAMÉTRÉS : un exercice écrit une fois fabrique autant de variantes qu'on veut, avec des réponses exactes, sans jeton.

Un gabarit est un fichier JSON DÉCLARATIF (dossier `app/gabarits/`) :

    {"id": "derivee-polynome", "titre": "...", "matiere": "Mathématiques", "classes": ["terminale"], "chapitre": "Dérivation", "difficulte": 1,
     "variables": {"a": {"entier": [1, 5]}, "b": {"entier": [-9, 9], "non_nul": true}, "c": {"choix": [2, 4, 6]}, "p": {"decimal": [0.5, 9.5, 0.5]}},
     "calculs": {"d1": "2*b"},                  # grandeurs dérivées, dans l'ordre
     "contraintes": ["a != b"],                 # le tirage est refait tant qu'une contrainte est fausse
     "enonce": "Soit $f(x) = {{poly(a, b, c)}}$.",
     "questions": [{"enonce": "Calculer $f'(x)$.", "reponse": "$f'(x) = {{poly(2*a, b)}}$", "etapes": "...", "points": 1}]}

SÉCURITÉ. Aucun code n'est exécuté : les formules `{{ ... }}`, `calculs` et `contraintes` sont analysées par `ast` puis évaluées par un évaluateur à LISTE BLANCHE
(nombres, + - * / // % **, comparaisons, `et`/`ou`, et les fonctions ci-dessous), en fractions EXACTES, avec bornes de taille. Un gabarit écrit par une IA ne peut donc rien
exécuter sur le serveur. L'exactitude des formules, elle, se vérifie par recalcul indépendant (SymPy, hors serveur : `scripts_dev/verif_gabarits.py`) puis par un enseignant.

Un gabarit n'est montré aux élèves que s'il est VALIDÉ (table `gabarit_validations`, liée au HASH de son contenu : toute modification retire la validation).
"""
from __future__ import annotations

import ast
import hashlib
import json
import math
import random
import re
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction
from pathlib import Path
from typing import Any, Optional

from .logging_config import get_logger
from .referentiel import CLASSES_SECONDAIRE

log = get_logger("gabarits")

DOSSIER = Path(__file__).resolve().parent.parent / "gabarits"
MAX_EXPR_CHARS = 300
MAX_NOEUDS = 120
MAX_VALEUR = 10**12
MAX_DENOMINATEUR = 10**9
MAX_TENTATIVES = 300
MAX_VARIABLES = 16
MAX_QUESTIONS = 12
GRAINE_MAX = 2**31 - 1
CODES_CLASSES = {c["code"] for c in CLASSES_SECONDAIRE}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,63}$")
NOM_RE = re.compile(r"^[a-z][a-z0-9_]{0,15}$")
SEGMENT_RE = re.compile(r"\{\{(.+?)\}\}", re.DOTALL)


class GabaritError(Exception):
    """Gabarit invalide, ou tirage impossible."""


class Texte(str):
    """Fragment Markdown/LaTeX produit par une fonction de mise en forme (distinct d'un nombre : on n'en fait pas d'arithmétique)."""


# --- Mise en forme -------------------------------------------------------------------------------------------------------

def _tex(x: Fraction) -> str:
    if x.denominator == 1:
        return str(x.numerator)
    return f"{'-' if x < 0 else ''}\\frac{{{abs(x.numerator)}}}{{{x.denominator}}}"


def _entier(x: Fraction, nom: str) -> int:
    if x.denominator != 1:
        raise GabaritError(f"{nom} attend un entier")
    return x.numerator


def _dec(x: Fraction, n: Fraction = Fraction(2)) -> str:
    chiffres = _entier(n, "dec")
    if not 0 <= chiffres <= 8:
        raise GabaritError("dec : de 0 à 8 décimales")
    q = (Decimal(x.numerator) / Decimal(x.denominator)).quantize(Decimal(1).scaleb(-chiffres), rounding=ROUND_HALF_UP)
    if q == 0:
        q = abs(q)
    return f"{q:f}".replace(".", "{,}")


def _plus(x: Fraction) -> str:
    return f"{'-' if x < 0 else '+'} {_tex(abs(x))}"


def _par(x: Fraction) -> str:
    return f"({_tex(x)})" if x < 0 else _tex(x)


def _poly(*args: Any) -> str:
    """Polynôme en LaTeX à partir des coefficients du plus haut degré au degré 0 ; une chaîne finale donne la variable (défaut « x »).
    Les coefficients nuls sont omis, les ±1 s'écrivent sans chiffre : poly(2, -1, 0, 1) → 2x^{3} - x^{2} + 1."""
    variable = "x"
    if args and isinstance(args[-1], str):
        variable, args = args[-1], args[:-1]
    if not re.fullmatch(r"[a-zA-Z]", variable):
        raise GabaritError("poly : la variable est une lettre")
    n = len(args) - 1
    termes: list[tuple[str, str]] = []
    for i, c in enumerate(args):
        if c == 0:
            continue
        deg = n - i
        corps = "" if abs(c) == 1 and deg > 0 else _tex(abs(c))
        mono = "" if deg == 0 else (variable if deg == 1 else f"{variable}^{{{deg}}}")
        termes.append(("-" if c < 0 else "+", corps + mono))
    if not termes:
        return "0"
    (s0, t0), reste = termes[0], termes[1:]
    return ("-" if s0 == "-" else "") + t0 + "".join(f" {s} {t}" for s, t in reste)


def _cplx(a: Fraction, b: Fraction) -> str:
    """Nombre complexe a + bi : cplx(3, -1) → 3 - i ; cplx(0, 2) → 2i ; cplx(-4, 0) → -4."""
    if b == 0:
        return _tex(a)
    corps = "i" if abs(b) == 1 else _tex(abs(b)) + "i"
    if a == 0:
        return ("-" if b < 0 else "") + corps
    return f"{_tex(a)} {'-' if b < 0 else '+'} {corps}"


def _rac(n: Fraction) -> str:
    v = _entier(n, "rac")
    if v < 0:
        raise GabaritError("rac : nombre négatif")
    r = math.isqrt(v)
    return str(r) if r * r == v else f"\\sqrt{{{v}}}"


def _racine(x: Fraction) -> Fraction:
    if x < 0:
        raise GabaritError("racine d'un nombre négatif")
    n, d = math.isqrt(x.numerator), math.isqrt(x.denominator)
    if n * n != x.numerator or d * d != x.denominator:
        raise GabaritError("racine : pas un carré parfait")
    return Fraction(n, d)


def _arrondi(x: Fraction, n: Fraction = Fraction(0)) -> Fraction:
    chiffres = _entier(n, "arrondi")
    if not 0 <= chiffres <= 8:
        raise GabaritError("arrondi : de 0 à 8 décimales")
    q = (Decimal(x.numerator) / Decimal(x.denominator)).quantize(Decimal(1).scaleb(-chiffres), rounding=ROUND_HALF_UP)
    return Fraction(q)


def _comb(n: Fraction, k: Fraction) -> Fraction:
    n_, k_ = _entier(n, "comb"), _entier(k, "comb")
    if not 0 <= k_ <= n_ <= 60:
        raise GabaritError("comb : 0 ≤ k ≤ n ≤ 60")
    return Fraction(math.comb(n_, k_))


def _fact(n: Fraction) -> Fraction:
    n_ = _entier(n, "fact")
    if not 0 <= n_ <= 15:
        raise GabaritError("fact : de 0 à 15")
    return Fraction(math.factorial(n_))


def _deux_entiers(nom: str, f):
    def g(a: Fraction, b: Fraction) -> Fraction:
        return Fraction(f(_entier(a, nom), _entier(b, nom)))
    return g


# Fonctions NUMÉRIQUES (arguments et résultat : Fraction) et fonctions de MISE EN FORME (résultat : Texte)
NUMERIQUES: dict[str, Any] = {
    "abs": abs, "min": min, "max": max,
    "pgcd": _deux_entiers("pgcd", math.gcd), "ppcm": _deux_entiers("ppcm", math.lcm),
    "reste": _deux_entiers("reste", lambda a, b: a % b), "quotient": _deux_entiers("quotient", lambda a, b: a // b),
    "sgn": lambda x: Fraction((x > 0) - (x < 0)), "ent": lambda x: Fraction(math.floor(x)),
    "racine": _racine, "arrondi": _arrondi, "comb": _comb, "fact": _fact,
    "est_carre": lambda x: Fraction(int(x >= 0 and x.denominator == 1 and math.isqrt(x.numerator) ** 2 == x.numerator)),
}
def _milliers(x: Fraction) -> str:
    """Entier avec espace insécable fine entre les milliers, pour du TEXTE : 15000 → « 15 000 »."""
    n = _entier(x, "milliers")
    return ("-" if n < 0 else "") + f"{abs(n):,}".replace(",", "\u202f")


def _milliers_tex(x: Fraction) -> str:
    """Même chose DANS une formule LaTeX : 15000 → 15\\,000."""
    n = _entier(x, "milliers_tex")
    return ("-" if n < 0 else "") + f"{abs(n):,}".replace(",", "\\,")


def _decimal(x: Fraction) -> str:
    """Nombre décimal EXACT avec virgule française, sans zéros inutiles : 5/4 → 1{,}25 ; 3 → 3. Refuse un rationnel qui n'est pas décimal (1/3)."""
    d = x.denominator
    deux = cinq = 0
    while d % 2 == 0:
        d //= 2
        deux += 1
    while d % 5 == 0:
        d //= 5
        cinq += 1
    if d != 1:
        raise GabaritError("decimal : ce nombre n'a pas d'écriture décimale exacte")
    chiffres = max(deux, cinq)
    if chiffres > 8:
        raise GabaritError("decimal : trop de décimales")
    entier = abs(x.numerator) * 10**chiffres // x.denominator
    texte = str(entier).rjust(chiffres + 1, "0")
    avant, apres = (texte[:-chiffres], texte[-chiffres:]) if chiffres else (texte, "")
    return ("-" if x < 0 else "") + avant + (("{,}" + apres) if apres else "")


def _si(*_: Any) -> str:  # évaluée à part dans `_eval` (condition booléenne) ; l'entrée ici ne sert qu'à déclarer le nom
    raise GabaritError("si : appel invalide")


FORMATS: dict[str, Any] = {"tex": _tex, "dec": _dec, "plus": _plus, "par": _par, "poly": _poly, "cplx": _cplx, "rac": _rac, "si": _si, "texte": _si,
                           "milliers": _milliers, "milliers_tex": _milliers_tex, "decimal": _decimal}


# --- Évaluateur à liste blanche ------------------------------------------------------------------------------------------

def _compiler(expression: str) -> ast.Expression:
    if not isinstance(expression, str) or not expression.strip():
        raise GabaritError("expression vide")
    if len(expression) > MAX_EXPR_CHARS:
        raise GabaritError(f"expression trop longue (plus de {MAX_EXPR_CHARS} caractères) : {expression[:40]}…")
    try:
        arbre = ast.parse(expression.strip(), mode="eval")
    except SyntaxError as exc:
        raise GabaritError(f"expression illisible « {expression} » : {exc.msg}") from exc
    noeuds = list(ast.walk(arbre))
    if len(noeuds) > MAX_NOEUDS:
        raise GabaritError(f"expression trop complexe : {expression[:40]}…")
    permis = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Name, ast.Load, ast.Call, ast.Compare, ast.BoolOp,
              ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow, ast.USub, ast.UAdd, ast.Not,
              ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.And, ast.Or)
    for n in noeuds:
        if not isinstance(n, permis):
            raise GabaritError(f"construction interdite ({type(n).__name__}) dans « {expression} »")
        if isinstance(n, ast.Call) and (not isinstance(n.func, ast.Name) or n.func.id not in {**NUMERIQUES, **FORMATS} or n.keywords):
            raise GabaritError(f"appel interdit dans « {expression} »")
        if isinstance(n, ast.Constant) and (isinstance(n.value, bool) or not isinstance(n.value, int | float | str)
                                            or (isinstance(n.value, float) and not math.isfinite(n.value))):
            raise GabaritError(f"constante interdite dans « {expression} »")
    return arbre


def _noms(arbre: ast.Expression) -> set[str]:
    appeles = {n.func.id for n in ast.walk(arbre) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
    return {n.id for n in ast.walk(arbre) if isinstance(n, ast.Name)} - appeles


def _borne(v: Fraction) -> Fraction:
    if abs(v) > MAX_VALEUR or v.denominator > MAX_DENOMINATEUR:
        raise GabaritError("valeur trop grande")
    return v


def _num(v: Any) -> Fraction:
    if isinstance(v, Fraction):
        return v
    raise GabaritError("une valeur numérique est attendue")


def _eval(n: ast.AST, env: dict[str, Fraction]) -> Any:
    if isinstance(n, ast.Expression):
        return _eval(n.body, env)
    if isinstance(n, ast.Constant):
        return n.value if isinstance(n.value, str) else Fraction(repr(n.value) if isinstance(n.value, float) else n.value)
    if isinstance(n, ast.Name):
        if n.id not in env:
            raise GabaritError(f"variable inconnue : {n.id}")
        return env[n.id]
    if isinstance(n, ast.UnaryOp):
        v = _eval(n.operand, env)
        if isinstance(n.op, ast.Not):
            return not _verite(v)
        return -_num(v) if isinstance(n.op, ast.USub) else _num(v)
    if isinstance(n, ast.BinOp):
        a, b = _num(_eval(n.left, env)), _num(_eval(n.right, env))
        if isinstance(n.op, ast.Add):
            return _borne(a + b)
        if isinstance(n.op, ast.Sub):
            return _borne(a - b)
        if isinstance(n.op, ast.Mult):
            return _borne(a * b)
        if isinstance(n.op, ast.Pow):
            if b.denominator != 1 or not -8 <= b <= 8 or (b < 0 and a == 0):
                raise GabaritError("puissance : exposant entier de -8 à 8")
            return _borne(a ** b.numerator)
        if b == 0:
            raise GabaritError("division par zéro")
        if isinstance(n.op, ast.Div):
            return _borne(a / b)
        if a.denominator != 1 or b.denominator != 1:
            raise GabaritError("// et % attendent des entiers")
        return Fraction(a.numerator // b.numerator) if isinstance(n.op, ast.FloorDiv) else Fraction(a.numerator % b.numerator)
    if isinstance(n, ast.Compare):
        gauche = _num(_eval(n.left, env))
        for op, droite_n in zip(n.ops, n.comparators, strict=True):
            droite = _num(_eval(droite_n, env))
            ok = {ast.Eq: gauche == droite, ast.NotEq: gauche != droite, ast.Lt: gauche < droite, ast.LtE: gauche <= droite,
                  ast.Gt: gauche > droite, ast.GtE: gauche >= droite}[type(op)]
            if not ok:
                return False
            gauche = droite
        return True
    if isinstance(n, ast.BoolOp):
        valeurs = (_verite(_eval(v, env)) for v in n.values)
        return all(valeurs) if isinstance(n.op, ast.And) else any(valeurs)
    if isinstance(n, ast.Call):
        nom = n.func.id  # type: ignore[attr-defined]
        args = [_eval(a, env) for a in n.args]
        if nom == "si":  # si(condition, "texte si vrai", "texte sinon") : réponses du type « Oui / Non »
            if len(args) != 3 or not isinstance(args[1], str) or not isinstance(args[2], str):
                raise GabaritError('si : si(condition, "texte si vrai", "texte sinon")')
            return Texte(args[1] if _verite(args[0]) else args[2])
        if nom == "texte":  # texte(i, "a", "b", "c") : le i-ème texte (en partant de 0) — noms, objets, lieux variables
            if len(args) < 2 or not all(isinstance(a, str) for a in args[1:]) or not isinstance(args[0], Fraction) or args[0].denominator != 1 or not 0 <= args[0] < len(args) - 1:
                raise GabaritError('texte : texte(indice, "a", "b", …) avec 0 ≤ indice < nombre de textes')
            return Texte(args[1 + args[0].numerator])
        try:
            if nom in FORMATS:
                return Texte(FORMATS[nom](*(a if isinstance(a, str) else _num(a) for a in args)))
            if not args or not all(isinstance(a, Fraction) for a in args):
                raise GabaritError(f"{nom} : arguments numériques attendus")
            return _borne(Fraction(NUMERIQUES[nom](*args)))
        except GabaritError:
            raise
        except (TypeError, AttributeError, ValueError, ArithmeticError) as exc:  # mauvais arguments, division par zéro dans reste(a, 0)…
            raise GabaritError(f"{nom} : arguments invalides ({type(exc).__name__})") from exc
    raise GabaritError("expression non permise")


def _verite(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, Fraction):
        return v != 0
    raise GabaritError("une condition est attendue")


# --- Gabarit ------------------------------------------------------------------------------------------------------------

def _decouper(texte: str) -> list[tuple[str, Optional[ast.Expression]]]:
    """Découpe un texte en [(littéral, expression à évaluer ensuite)] selon les marques {{ ... }}."""
    morceaux: list[tuple[str, Optional[ast.Expression]]] = []
    fin = 0
    for m in SEGMENT_RE.finditer(texte):
        litteral = texte[fin:m.start()]
        if "{{" in litteral or "}}" in litteral:
            raise GabaritError(f"accolades doublées non refermées avant : {m.group(0)[:40]}")
        morceaux.append((litteral, _compiler(m.group(1))))
        fin = m.end()
    reste = texte[fin:]
    if "{{" in reste or "}}" in reste:
        raise GabaritError(f"accolades doublées non refermées dans : {texte[:50]}… (mettre un espace dans `{{ {{` pour du LaTeX)")
    morceaux.append((reste, None))
    return morceaux


def _rendre(morceaux: list[tuple[str, Optional[ast.Expression]]], env: dict[str, Fraction]) -> str:
    sortie = []
    for litteral, expr in morceaux:
        sortie.append(litteral)
        if expr is not None:
            v = _eval(expr, env)
            if isinstance(v, bool) or isinstance(v, str) and not isinstance(v, Texte):
                raise GabaritError("une formule {{ }} doit donner un nombre ou un texte mis en forme")
            sortie.append(v if isinstance(v, Texte) else _tex(v))
    return "".join(sortie)


def _nombre(v: Any, ou: str) -> Fraction:
    if isinstance(v, bool) or not isinstance(v, int | float):
        raise GabaritError(f"{ou} : nombre attendu")
    return Fraction(repr(v)) if isinstance(v, float) else Fraction(v)


class Gabarit:
    """Gabarit validé et compilé. Lève GabaritError à la construction si quoi que ce soit est invalide."""

    def __init__(self, brut: dict):
        if not isinstance(brut, dict):
            raise GabaritError("un gabarit est un objet JSON")
        self.brut = brut
        self.hash = hashlib.sha256(json.dumps(brut, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        self.id = self._texte("id")
        if not ID_RE.match(self.id):
            raise GabaritError(f"id invalide « {self.id} » (minuscules, chiffres et tirets, 3 à 64 caractères)")
        self.titre = self._texte("titre")
        self.matiere = self._texte("matiere")
        self.chapitre = self._texte("chapitre")
        classes = brut.get("classes")
        if not isinstance(classes, list) or not classes or not all(isinstance(c, str) and c.strip() for c in classes):
            raise GabaritError("classes : liste non vide de textes")
        self.classes = [c.strip() for c in classes]
        inconnues = [c for c in self.classes if c not in CODES_CLASSES]
        if inconnues:
            raise GabaritError(f"classes : codes inconnus du référentiel : {', '.join(inconnues)} (attendus : {', '.join(sorted(CODES_CLASSES))})")
        d = brut.get("difficulte", 1)
        if d not in (1, 2, 3) or isinstance(d, bool):
            raise GabaritError("difficulte : 1, 2 ou 3")
        self.difficulte = d

        variables = brut.get("variables")
        if not isinstance(variables, dict) or not variables or len(variables) > MAX_VARIABLES:
            raise GabaritError(f"variables : de 1 à {MAX_VARIABLES}")
        self.variables: list[tuple[str, dict]] = []
        for nom, spec in variables.items():
            if not NOM_RE.match(nom) or nom in NUMERIQUES or nom in FORMATS:
                raise GabaritError(f"nom de variable invalide ou réservé : {nom}")
            self.variables.append((nom, self._spec(nom, spec)))
        connus = {nom for nom, _ in self.variables}

        calculs = brut.get("calculs", {})
        if not isinstance(calculs, dict):
            raise GabaritError("calculs : un objet {nom: expression}")
        self.calculs: list[tuple[str, ast.Expression]] = []
        for nom, expr in calculs.items():
            if not NOM_RE.match(nom) or nom in connus or nom in NUMERIQUES or nom in FORMATS:
                raise GabaritError(f"nom de calcul invalide, réservé ou en double : {nom}")
            arbre = _compiler(expr)
            self._noms_connus(arbre, connus, f"calcul {nom}")
            self.calculs.append((nom, arbre))
            connus.add(nom)
        contraintes = brut.get("contraintes", [])
        if not isinstance(contraintes, list):
            raise GabaritError("contraintes : une liste d'expressions")
        self.contraintes = []
        for expr in contraintes:
            arbre = _compiler(expr)
            self._noms_connus(arbre, connus, "contrainte")
            self.contraintes.append(arbre)

        self.enonce = self._modele(self._texte("enonce"), connus)
        questions = brut.get("questions")
        if not isinstance(questions, list) or not 1 <= len(questions) <= MAX_QUESTIONS:
            raise GabaritError(f"questions : de 1 à {MAX_QUESTIONS}")
        self.questions: list[dict] = []
        for i, q in enumerate(questions, 1):
            if not isinstance(q, dict):
                raise GabaritError(f"question {i} : un objet")
            pts = _nombre(q.get("points"), f"question {i} : points")
            if pts <= 0 or pts % Fraction(1, 4) != 0:
                raise GabaritError(f"question {i} : points positifs, par quarts de point")
            self.questions.append({
                "enonce": self._modele(self._texte("enonce", q, f"question {i}"), connus),
                "reponse": self._modele(self._texte("reponse", q, f"question {i}"), connus),
                "etapes": self._modele(self._texte("etapes", q, f"question {i}"), connus),
                "points": pts,
            })
        self.total_points = sum(q["points"] for q in self.questions)

    # -- construction
    def _texte(self, cle: str, source: Optional[dict] = None, ou: str = "gabarit") -> str:
        v = (self.brut if source is None else source).get(cle)
        if not isinstance(v, str) or not v.strip():
            raise GabaritError(f"{ou} : « {cle} » est obligatoire (texte non vide)")
        return v

    def _modele(self, texte: str, connus: set[str]):
        morceaux = _decouper(texte)
        for _, expr in morceaux:
            if expr is not None:
                self._noms_connus(expr, connus, "texte")
        return morceaux

    @staticmethod
    def _noms_connus(arbre: ast.Expression, connus: set[str], ou: str) -> None:
        inconnus = _noms(arbre) - connus
        if inconnus:
            raise GabaritError(f"{ou} : variable inconnue ou pas encore définie : {', '.join(sorted(inconnus))}")

    @staticmethod
    def _spec(nom: str, spec: Any) -> dict:
        if not isinstance(spec, dict) or len([k for k in ("entier", "choix", "decimal") if k in spec]) != 1:
            raise GabaritError(f"variable {nom} : exactement un type parmi entier, choix, decimal")
        sauf = spec.get("sauf", [])
        if not isinstance(sauf, list) or not all(isinstance(s, int) and not isinstance(s, bool) for s in sauf):
            raise GabaritError(f"variable {nom} : « sauf » est une liste d'entiers")
        if spec.get("non_nul"):
            sauf = [*sauf, 0]
        if "entier" in spec:
            bornes = spec["entier"]
            if not (isinstance(bornes, list) and len(bornes) == 2 and all(isinstance(b, int) and not isinstance(b, bool) for b in bornes)) or bornes[0] > bornes[1]:
                raise GabaritError(f"variable {nom} : entier = [min, max] avec min ≤ max")
            if bornes[1] - bornes[0] > 100_000:
                raise GabaritError(f"variable {nom} : intervalle trop grand")
            valeurs = [Fraction(v) for v in range(bornes[0], bornes[1] + 1) if v not in sauf]
        elif "choix" in spec:
            liste = spec["choix"]
            if not isinstance(liste, list) or not 1 <= len(liste) <= 200:
                raise GabaritError(f"variable {nom} : choix = liste de 1 à 200 nombres")
            valeurs = [_nombre(v, f"variable {nom}") for v in liste if v not in sauf]
        else:
            d = spec["decimal"]
            if not isinstance(d, list) or len(d) != 3:
                raise GabaritError(f"variable {nom} : decimal = [min, max, pas]")
            lo, hi, pas = (_nombre(v, f"variable {nom}") for v in d)
            if pas <= 0 or lo > hi or (hi - lo) / pas > 100_000:
                raise GabaritError(f"variable {nom} : decimal = [min, max, pas] avec pas > 0 et min ≤ max")
            valeurs = [lo + pas * k for k in range(int((hi - lo) / pas) + 1)]
        if not valeurs:
            raise GabaritError(f"variable {nom} : aucune valeur possible")
        return {"valeurs": valeurs}

    # -- tirage
    def tirer(self, graine: int) -> dict[str, Fraction]:
        """Valeurs des variables et des calculs pour cette graine : même graine, mêmes valeurs. Les tirages qui violent une contrainte
        (ou font une division par zéro) sont refaits, au plus MAX_TENTATIVES fois."""
        if isinstance(graine, bool) or not isinstance(graine, int) or not 0 <= graine <= GRAINE_MAX:
            raise GabaritError("graine invalide")
        rng = random.Random(graine)
        for _ in range(MAX_TENTATIVES):
            env = {nom: rng.choice(spec["valeurs"]) for nom, spec in self.variables}
            try:
                for nom, expr in self.calculs:
                    env[nom] = _num(_eval(expr, env))
                if all(_verite(_eval(c, env)) for c in self.contraintes):
                    return env
            except GabaritError:
                continue
        raise GabaritError("aucun tirage ne satisfait les contraintes")

    def instancier(self, graine: int) -> dict:
        """Tout ce qu'il faut pour une variante : énoncé, questions, corrections. Voir `vue_eleve` / `vue_correction`."""
        env = self.tirer(graine)
        return {
            "id": self.id, "titre": self.titre, "graine": graine,
            "enonce": _rendre(self.enonce, env),
            "questions": [{"enonce": _rendre(q["enonce"], env), "points": float(q["points"])} for q in self.questions],
            "corrections": [{"reponse": _rendre(q["reponse"], env), "etapes": _rendre(q["etapes"], env)} for q in self.questions],
            "total_points": float(self.total_points),
        }

    def resume(self) -> dict:
        return {"id": self.id, "titre": self.titre, "matiere": self.matiere, "classes": self.classes, "chapitre": self.chapitre,
                "difficulte": self.difficulte, "total_points": float(self.total_points)}


def vue_eleve(inst: dict) -> dict:
    """La variante SANS ses réponses."""
    return {k: inst[k] for k in ("id", "titre", "graine", "enonce", "questions", "total_points")}


def vue_correction(inst: dict) -> dict:
    return {"id": inst["id"], "graine": inst["graine"], "corrections": inst["corrections"]}


# --- Validation (rapport sur N graines) -----------------------------------------------------------------------------------

# défauts de rendu : accolades de gabarit restantes, valeurs Python qui ne devraient jamais s'afficher (mots entiers : « \infty » est légitime)
_DEFAUTS = re.compile(r"\{\{|\}\}|\bNone\b|\bnan\b|\binf\b|Fraction\(")


def rapport_validation(g: Gabarit, n: int = 200) -> dict:
    """Essaie les graines 0…n-1 : toute erreur, tout défaut de rendu (accolades restantes, « None », « nan »…), et la VARIÉTÉ des énoncés obtenus.
    `ok` est vrai s'il n'y a aucune erreur ; une faible variété n'est qu'un avertissement."""
    echecs, defauts, distincts = 0, 0, set()
    exemple: Optional[str] = None
    for graine in range(n):
        try:
            inst = g.instancier(graine)
        except GabaritError as exc:
            echecs += 1
            exemple = exemple or f"graine {graine} : {exc}"
            continue
        texte = "\n".join([inst["enonce"], *(q["enonce"] for q in inst["questions"]),
                           *(c["reponse"] + c["etapes"] for c in inst["corrections"])])
        mauvais = _DEFAUTS.search(texte)
        if mauvais:
            defauts += 1
            exemple = exemple or f"graine {graine} : « {mauvais.group(0)} » dans le texte rendu"
        distincts.add(inst["enonce"] + "".join(q["enonce"] for q in inst["questions"]))
    avertissements = []
    if len(distincts) < min(10, n):
        avertissements.append(f"peu de variété : {len(distincts)} énoncé(s) distinct(s) sur {n} graines")
    return {"n": n, "echecs": echecs, "defauts": defauts, "enonces_distincts": len(distincts), "exemple_erreur": exemple,
            "avertissements": avertissements, "ok": echecs == 0 and defauts == 0}


# --- Chargement ---------------------------------------------------------------------------------------------------------

def charger_dossier(dossier: Path = DOSSIER) -> tuple[dict[str, Gabarit], dict[str, str]]:
    """Gabarits valides (id → Gabarit) et fichiers invalides (nom → message). Un fichier invalide est ignoré (journalisé), il ne bloque pas le serveur."""
    valides: dict[str, Gabarit] = {}
    erreurs: dict[str, str] = {}
    for chemin in sorted(dossier.glob("*.json")):
        try:
            g = Gabarit(json.loads(chemin.read_text(encoding="utf-8")))
            if g.id != chemin.stem:
                raise GabaritError(f"l'id « {g.id} » doit être le nom du fichier « {chemin.stem} »")
            if g.id in valides:
                raise GabaritError("id en double")
            valides[g.id] = g
        except (GabaritError, ValueError) as exc:
            erreurs[chemin.name] = str(exc)
            log.error("Gabarit ignoré (%s) : %s", chemin.name, exc)
    return valides, erreurs


_CACHE: Optional[tuple[dict[str, Gabarit], dict[str, str]]] = None


def tous() -> tuple[dict[str, Gabarit], dict[str, str]]:
    global _CACHE
    if _CACHE is None:
        _CACHE = charger_dossier()
    return _CACHE
