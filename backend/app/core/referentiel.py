"""Référentiel de classification des épreuves (système scolaire camerounais).

Les listes ci-dessous sont INDICATIVES : le catalogue n'y est pas strictement
limité (une matière ou une série inconnue peut exister en base), mais elles
servent de référence pour les sélecteurs du back-office, la normalisation
des saisies et l'ordre d'affichage des classes.

Le projet couvre à terme tout le secondaire (6e → Terminale). Seul le niveau
SECONDAIRE est actif pour l'instant ; PRIMAIRE est réservé (carte désactivée
dans la navigation).
"""
from __future__ import annotations

import unicodedata

# ---------- Niveaux ----------

NIVEAU_SECONDAIRE = "SECONDAIRE"
NIVEAU_PRIMAIRE = "PRIMAIRE"

# Niveaux connus, dans l'ordre d'affichage. `actif` décide si le niveau est
# proposé dans la navigation (une carte de niveau inactif est désactivée).
NIVEAUX: list[dict] = [
    {"code": NIVEAU_PRIMAIRE, "label": "Primaire", "actif": False},
    {"code": NIVEAU_SECONDAIRE, "label": "Secondaire", "actif": True},
]

# ---------- Classes du secondaire (ordre croissant de scolarité) ----------

# `code` : valeur canonique stockée en base et utilisée dans les URL ;
# `label` : libellé affiché. Les alias permettent de normaliser des saisies
# variées ("Terminale", "terminale", "1ère", "première", "seconde"...).
CLASSES_SECONDAIRE: list[dict] = [
    {"code": "6e", "label": "6e", "aliases": ["6eme", "sixieme"]},
    {"code": "5e", "label": "5e", "aliases": ["5eme", "cinquieme"]},
    {"code": "4e", "label": "4e", "aliases": ["4eme", "quatrieme"]},
    {"code": "3e", "label": "3e", "aliases": ["3eme", "troisieme"]},
    {"code": "2nde", "label": "2nde", "aliases": ["seconde", "2nd"]},
    {"code": "1ere", "label": "1ère", "aliases": ["premiere", "1re"]},
    {"code": "terminale", "label": "Terminale", "aliases": ["tle", "tle "]},
]

CLASSES_CODES = [c["code"] for c in CLASSES_SECONDAIRE]
CLASSES_LABELS = {c["code"]: c["label"] for c in CLASSES_SECONDAIRE}

# ---------- Évaluations ----------

EVALUATIONS: list[str] = [
    "CEP",
    "BEPC",
    "PROBATOIRE",
    "BAC",
    "SEQUENCE 1",
    "SEQUENCE 2",
    "SEQUENCE 3",
    "COMPOSITION TRIMESTRIELLE",
    "EXAMEN BLANC",
    "CONCOURS",
    "AUTRE",
]

# Évaluations certificielles → classe par défaut quand elle n'est pas
# précisée (utilisée par le seed et l'import massif).
_CLASSE_PAR_DEFAUT_EVALUATION = {
    "CEP": "",  # primaire — hors périmètre actuel
    "BEPC": "3e",
    "PROBATOIRE": "1ere",
    "BAC": "terminale",
}


def fold(value: str) -> str:
    """Normalise une chaîne pour comparaison insensible casse/accents
    (miroir de `foldText` côté frontend et de `LOWER()` côté SQLite)."""
    if not isinstance(value, str):
        return ""
    decomposed = unicodedata.normalize("NFKD", value)
    without_accents = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return without_accents.strip().lower()


def normalize_niveau(value: str | None) -> str:
    """Ramène une saisie de niveau vers son code canonique (SECONDAIRE par
    défaut)."""
    folded = fold(value or "")
    if folded.startswith("prim"):
        return NIVEAU_PRIMAIRE
    return NIVEAU_SECONDAIRE


def normalize_classe(value: str | None) -> str | None:
    """Ramène une saisie de classe vers son code canonique ("1ère", "1ere",
    "première" → "1ere"), ou None si aucune classe connue ne correspond."""
    folded = fold(value or "")
    if not folded:
        return None
    for entry in CLASSES_SECONDAIRE:
        if folded == fold(entry["code"]) or folded == fold(entry["label"]):
            return entry["code"]
        for alias in entry["aliases"]:
            if folded == fold(alias):
                return entry["code"]
    return None


def classe_label(code: str | None) -> str:
    """Libellé d'affichage d'une classe (le code lui-même si inconnu)."""
    if not code:
        return ""
    return CLASSES_LABELS.get(code, code)


def default_classe_for_evaluation(evaluation: str | None) -> str:
    """Classe indicative associée à une évaluation certificielle
    ("terminale" par défaut pour tout le reste)."""
    return _CLASSE_PAR_DEFAUT_EVALUATION.get((evaluation or "").strip().upper(), "terminale")


def normalize_evaluation(value: str | None) -> str:
    """Normalise une évaluation vers l'une des valeurs canoniques si
    possible ("bac" → "BAC", "examen blanc" → "EXAMEN BLANC"), sinon
    renvoie la saisie nettoyée telle quelle (le référentiel est indicatif)."""
    folded = fold(value or "")
    if not folded:
        return "AUTRE"
    for code in EVALUATIONS:
        if folded == fold(code):
            return code
    return (value or "").strip() or "AUTRE"


# ---------- Séries / filières ----------

# Séries indicatives du secondaire camerounais — une épreuve peut couvrir
# PLUSIEURS séries (relation many-to-many `epreuve_filieres`). Une valeur
# hors de cette liste reste acceptable (référentiel non exhaustif).
SERIES_CONNUES: list[str] = ["A", "C", "D", "E", "TI", "F", "G", "ESP"]


def normalize_serie(value: str | None) -> str:
    """Nettoie une série ("d" → "D") ; les libellés composés connus
    ("espagnol" → "ESP") sont ramenés à leur code."""
    folded = fold(value or "")
    aliases = {"a": "A", "c": "C", "d": "D", "e": "E", "ti": "TI", "f": "F", "g": "G",
               "esp": "ESP", "espagnol": "ESP"}
    if folded in aliases:
        return aliases[folded]
    return (value or "").strip()


# ---------- Matières (indicatives, pour les suggestions de l'admin) -------

MATIERES_CONNUES: list[str] = [
    "Mathématiques",
    "Physique",
    "Chimie",
    "SVT",
    "Français",
    "Anglais",
    "Espagnol",
    "Allemand",
    "Histoire",
    "Géographie",
    "Éducation civique",
    "Philosophie",
    "Informatique",
]
