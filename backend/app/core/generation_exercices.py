"""Atelier d'exercices (équipe) : génère un BROUILLON de sujet + corrigé au format des épreuves camerounaises (OBC).

Principes (voir docs/GENERATION_EXERCICES_GRATUITE.md) :
- le serveur décide de la STRUCTURE et du BARÈME (Partie A « ressources » 15 pts, Partie B « compétences » 5 pts) : il écrit lui-même les titres et
  répartit les points ; l'IA ne rédige que les questions — moins de façons de se tromper ;
- appels SÉPARÉS (plan → un appel par exercice → situation → corrigé) : chaque réponse reste courte, une panne ne perd pas tout ;
- le corrigé est écrit en RÉSOLVANT le sujet : tout énoncé ambigu, incomplet ou impossible est signalé par une ligne « ⚠ PROBLÈME » ;
- des CONTRÔLES automatiques (`controles_*`) vérifient ce qui se vérifie par le code : barème, numérotation, URL, doublons, formules ;
- RIEN n'est enregistré ni publié ici : le résultat est renvoyé à l'éditeur, que l'admin relit. Le texte généré n'est JAMAIS fiable sans relecture.

Les fonctions `repartir_points` / `controles_*` sont pures (testables sans réseau) ; `generer` est un générateur d'événements.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from fractions import Fraction
from typing import Optional
from collections.abc import AsyncIterator

from . import assistant
from .logging_config import get_logger

log = get_logger("generation_exercices")

POINTS_PARTIE_A = Fraction(15)
POINTS_PARTIE_B = Fraction(5)
NB_EXERCICES_MIN, NB_EXERCICES_MAX = 1, 5
PAS_BAREME = Fraction(1, 4)  # barème fin : multiples de 0,25 point

# --- Barème -------------------------------------------------------------------------------------------------------------

_PTS_RE = re.compile(r"\(\s*(\d+(?:[.,]\d+)?)\s*(?:pts?|points?)\s*\)", re.IGNORECASE)
_EXO_RE = re.compile(r"^###\s+Exercice\s+(\d+)\b", re.IGNORECASE | re.MULTILINE)
_PARTIE_B_RE = re.compile(r"^##\s+PARTIE\s+B\b", re.IGNORECASE | re.MULTILINE)
_URL_RE = re.compile(r"https?://", re.IGNORECASE)
_PROBLEME_RE = re.compile(r"^\s*(?:[>*_\-\s]*)⚠\s*PROBL[ÈE]ME\s*:?\s*(.*)$", re.IGNORECASE | re.MULTILINE)


def _frac(texte: str) -> Fraction:
    return Fraction(texte.replace(",", "."))


def formater_points(valeur: Fraction) -> str:
    """5 → « 5 » ; 15/4 → « 3,75 » ; 1/2 → « 0,5 » (virgule française)."""
    if valeur.denominator == 1:
        return str(valeur.numerator)
    return f"{float(valeur):g}".replace(".", ",")


def repartir_points(total: Fraction, n: int) -> list[Fraction]:
    """Répartit `total` points entre `n` exercices, par multiples de 0,25 ; le reste est donné par quarts aux premiers exercices.
    La somme est exacte. Ex. 15 sur 4 → 3,75 chacun ; 15 sur 7 → 2,25 ×4 puis 2 ×3."""
    quarts_total = int(total / PAS_BAREME)
    base, reste = divmod(quarts_total, n)
    return [PAS_BAREME * (base + (1 if i < reste else 0)) for i in range(n)]


def somme_points(markdown: str) -> Fraction:
    """Somme des « (x pt) » des lignes de question — les titres (lignes commençant par #) portent le total déclaré, pas des questions."""
    total = Fraction(0)
    for ligne in markdown.splitlines():
        if ligne.lstrip().startswith("#"):
            continue
        for m in _PTS_RE.finditer(ligne):
            total += _frac(m.group(1))
    return total


def _blocs_exercices(partie_a: str) -> list[tuple[int, str, str]]:
    """(numéro, titre complet, corps) de chaque `### Exercice k`."""
    reperes = list(_EXO_RE.finditer(partie_a))
    blocs = []
    for i, m in enumerate(reperes):
        fin = reperes[i + 1].start() if i + 1 < len(reperes) else len(partie_a)
        titre_fin = partie_a.find("\n", m.start())
        titre_fin = len(partie_a) if titre_fin == -1 else titre_fin
        blocs.append((int(m.group(1)), partie_a[m.start():titre_fin], partie_a[titre_fin:fin]))
    return blocs


def _declare(titre: str) -> Optional[Fraction]:
    m = _PTS_RE.search(titre)
    return _frac(m.group(1)) if m else None


def _controle(niveau: str, code: str, **params) -> dict:
    return {"niveau": niveau, "code": code, "params": params}


# --- Contrôles automatiques -----------------------------------------------------------------------------------------------

def controles_sujet(sujet: str, nb_exercices: int) -> list[dict]:
    """Contrôles du sujet : barème (par exercice, par partie, total 20), exercices présents, URL externes, questions en double, `$` impairs.
    Chaque contrôle est `{niveau: "erreur"|"avertissement", code, params}` : le client le traduit (FR/EN) à l'affichage."""
    res: list[dict] = []
    m_b = _PARTIE_B_RE.search(sujet)
    partie_a = sujet[: m_b.start()] if m_b else sujet
    partie_b = sujet[m_b.start():] if m_b else ""

    blocs = _blocs_exercices(partie_a)
    numeros = [k for k, _, _ in blocs]
    manquants = [k for k in range(1, nb_exercices + 1) if k not in numeros]
    if manquants:
        res.append(_controle("erreur", "exercices_manquants", manquants=manquants))
    for k, titre, corps in blocs:
        declare, trouve = _declare(titre), somme_points(corps)
        if declare is not None and declare != trouve:
            res.append(_controle("erreur", "bareme_exercice", k=k, attendu=formater_points(declare), trouve=formater_points(trouve)))
    trouve_a, trouve_b = somme_points(partie_a), somme_points(partie_b)
    if not m_b:
        res.append(_controle("erreur", "partie_b_absente"))
    if trouve_a != POINTS_PARTIE_A:
        res.append(_controle("erreur", "bareme_partie", partie="A", attendu=formater_points(POINTS_PARTIE_A), trouve=formater_points(trouve_a)))
    if m_b and trouve_b != POINTS_PARTIE_B:
        res.append(_controle("erreur", "bareme_partie", partie="B", attendu=formater_points(POINTS_PARTIE_B), trouve=formater_points(trouve_b)))
    if trouve_a + trouve_b != POINTS_PARTIE_A + POINTS_PARTIE_B:
        res.append(_controle("erreur", "bareme_total", attendu="20", trouve=formater_points(trouve_a + trouve_b)))

    res.extend(_controles_texte(sujet))
    # questions numérotées identiques d'un exercice à l'autre (même énoncé recopié)
    vues: dict[str, int] = {}
    for ligne in sujet.splitlines():
        m = re.match(r"^\s*\d+[.)]\s+(.{25,})$", ligne)
        if m:
            cle = re.sub(r"\s+", " ", _PTS_RE.sub("", m.group(1))).strip().lower()
            vues[cle] = vues.get(cle, 0) + 1
    doublons = [c for c, n in vues.items() if n > 1]
    if doublons:
        res.append(_controle("avertissement", "question_dupliquee", n=len(doublons), exemple=doublons[0][:80]))
    return res


def controles_corrige(corrige: str, nb_exercices: int) -> list[dict]:
    """Contrôles du corrigé : un titre par exercice, problèmes signalés par la résolution, URL externes, `$` impairs."""
    res: list[dict] = []
    numeros = [int(m.group(1)) for m in _EXO_RE.finditer(corrige)]
    manquants = [k for k in range(1, nb_exercices + 1) if k not in numeros]
    if manquants:
        res.append(_controle("avertissement", "corrige_exercices_manquants", manquants=manquants))
    problemes = [m.group(1).strip() for m in _PROBLEME_RE.finditer(corrige)]
    if problemes:
        res.append(_controle("avertissement", "probleme_signale", n=len(problemes), exemples=[p[:160] for p in problemes[:3]]))
    res.extend(_controles_texte(corrige))
    return res


def _controles_texte(markdown: str) -> list[dict]:
    res: list[dict] = []
    if _URL_RE.search(markdown):
        res.append(_controle("avertissement", "url_externe", n=len(_URL_RE.findall(markdown))))
    sans_blocs = markdown.replace("$$", "")
    if markdown.count("$$") % 2 or sans_blocs.count("$") % 2:
        res.append(_controle("avertissement", "delimiteur_formule"))
    return res


def a_des_erreurs(controles: list[dict]) -> bool:
    return any(c["niveau"] == "erreur" for c in controles)


# --- Consignes aux modèles ------------------------------------------------------------------------------------------------

def _contexte(meta: dict, theme: str, consignes: str) -> str:
    filieres = ", ".join(meta.get("filieres") or []) or "non précisée"
    lignes = [
        f"- Matière : {meta.get('matiere') or 'non précisée'}",
        f"- Classe : {meta.get('classe') or 'non précisée'} (série(s) : {filieres})",
        f"- Évaluation : {meta.get('evaluation') or 'non précisée'}",
        f"- Thème / chapitres à couvrir : {theme}",
    ]
    if consignes:
        lignes.append(f"- Consignes supplémentaires de l'enseignant : {consignes}")
    return "\n".join(lignes)


_REGLES = """RÈGLES DE FORME (obligatoires) :
- Français soigné, programme de l'enseignement secondaire du Cameroun ; contextes, lieux, noms et monnaie (FCFA) camerounais quand c'est pertinent.
- Mathématiques en LaTeX : $...$ en ligne, $$...$$ en bloc ; jamais d'image ni de lien internet ; pas de figure (décris par le texte si nécessaire).
- Chaque question est numérotée (1., 2., …) sur sa propre ligne et se termine par son barème entre parenthèses, au format exact « (0,5 pt) » ; barème par multiples de 0,25 point.
- Pas de préambule, pas de commentaire, pas de bloc de code : uniquement le Markdown demandé."""


def prompt_plan(meta: dict, theme: str, consignes: str, nb: int) -> str:
    return (
        "### ÉTAPE : plan\n"
        f"Tu aides un enseignant à préparer un sujet d'entraînement. Propose le PLAN de {nb} exercice(s) de la Partie A (évaluation des ressources) "
        "et le thème d'une situation de la Partie B (évaluation des compétences).\n"
        f"{_contexte(meta, theme, consignes)}\n\n"
        "Réponds UNIQUEMENT par un objet JSON, sans texte autour, de la forme :\n"
        '{"exercices": [{"titre": "...", "notions": "..."}], "situation": {"theme": "..."}}\n'
        f"avec exactement {nb} élément(s) dans « exercices », portant sur des notions différentes."
    )


def prompt_exercice(meta: dict, theme: str, consignes: str, k: int, pts: Fraction, plan: dict, deja: list[str], reparation: str = "") -> str:
    exo = plan["exercices"][k - 1]
    precedents = "\n".join(f"- {t}" for t in deja) or "(aucun)"
    repar = f"\nCORRECTION DEMANDÉE : {reparation}\n" if reparation else ""
    return (
        f"### ÉTAPE : exercice {k}\n"
        f"Rédige l'EXERCICE {k} de la Partie A du sujet.\n{_contexte(meta, theme, consignes)}\n"
        f"- Titre prévu : {exo['titre']}\n- Notions : {exo['notions']}\n"
        f"- Total de l'exercice : {formater_points(pts)} points : la SOMME des barèmes de ses questions doit valoir EXACTEMENT {formater_points(pts)}.\n"
        f"- Exercices déjà écrits (ne pas les répéter) :\n{precedents}\n{repar}\n"
        "Écris 4 à 6 questions de difficulté progressive, avec toutes les données nécessaires dans l'énoncé.\n"
        f"Commence directement par l'énoncé (le titre « Exercice {k} » est ajouté automatiquement).\n\n{_REGLES}"
    )


def prompt_situation(meta: dict, theme: str, consignes: str, plan: dict, reparation: str = "") -> str:
    repar = f"\nCORRECTION DEMANDÉE : {reparation}\n" if reparation else ""
    return (
        "### ÉTAPE : situation\n"
        "Rédige la PARTIE B (évaluation des compétences) : une SITUATION de vie réaliste et contextualisée au Cameroun, mobilisant les notions du thème, "
        "suivie d'une consigne et de 2 à 4 questions.\n"
        f"{_contexte(meta, theme, consignes)}\n- Thème de la situation : {plan['situation']['theme']}\n"
        f"- Total : {formater_points(POINTS_PARTIE_B)} points : la SOMME des barèmes des questions doit valoir EXACTEMENT {formater_points(POINTS_PARTIE_B)}.\n{repar}\n"
        "Commence par « ### Situation » puis le texte de la situation, la consigne et les questions.\n\n" + _REGLES
    )


def prompt_corrige(sujet: str) -> str:
    return (
        "### ÉTAPE : corrigé\n"
        "Voici un sujet. RÉSOUS d'abord toi-même chaque question, puis rédige le CORRIGÉ DÉTAILLÉ (réponse, justification brève, résultats avec unités).\n\n"
        "Reproduis EXACTEMENT les mêmes titres que le sujet (« ## PARTIE A… », « ### Exercice k… », « ## PARTIE B… », « ### Situation ») et le même barème "
        "« (x pt) » à la fin de chaque réponse.\n"
        "Si une question est ambiguë, incomplète, incohérente ou sans solution, écris juste après sa réponse une ligne commençant par « ⚠ PROBLÈME : » "
        "suivie d'une explication courte. Ne cache jamais un problème.\n\n"
        "Pas de préambule, pas de bloc de code : uniquement le Markdown.\n\n--- SUJET ---\n" + sujet
    )


# --- Appels et assemblage -----------------------------------------------------------------------------------------------

def _nettoyer(texte: str) -> str:
    """Retire une clôture ``` éventuelle et les espaces autour ; un modèle bavard enveloppe parfois sa réponse."""
    t = texte.strip()
    m = re.match(r"^```[a-zA-Z]*\n(.*)\n```$", t, re.DOTALL)
    return (m.group(1) if m else t).strip()


def _sans_titres_initiaux(texte: str) -> str:
    """Retire les titres (#…) du début : le serveur écrit lui-même « ### Exercice k (n points) »."""
    lignes = _nettoyer(texte).splitlines()
    while lignes and (not lignes[0].strip() or lignes[0].lstrip().startswith("#")):
        lignes.pop(0)
    return "\n".join(lignes).strip()


def _plan_de_secours(theme: str, nb: int) -> dict:
    return {"exercices": [{"titre": f"{theme} — exercice {k}", "notions": theme} for k in range(1, nb + 1)], "situation": {"theme": theme}}


def lire_plan(texte: str, nb: int, theme: str) -> dict:
    """Plan JSON de l'IA ; à défaut (JSON invalide, mauvais nombre d'exercices), plan de secours construit à partir du thème : la génération continue."""
    brut = _nettoyer(texte)
    debut, fin = brut.find("{"), brut.rfind("}")
    try:
        plan = json.loads(brut[debut:fin + 1])
        exos = plan["exercices"]
        if len(exos) == nb and all(isinstance(e.get("titre"), str) and isinstance(e.get("notions"), str) for e in exos) and isinstance(plan["situation"]["theme"], str):
            return plan
    except (ValueError, KeyError, TypeError, AttributeError):
        pass
    return _plan_de_secours(theme, nb)


class GenerationIndisponible(Exception):
    """Aucun fournisseur d'IA n'a répondu à une étape (même après nouvel essai)."""


def _pause_reessai() -> float:
    try:
        return max(0.0, float(os.getenv("GENERATION_PAUSE_REESSAI", "").strip() or 20))
    except ValueError:
        return 20.0


async def _appeler(prompt: str) -> str:
    """Un appel Groq (modèles de génération, distincts de ceux du tuteur). Un nouvel essai après une pause : les paliers gratuits limitent les jetons PAR MINUTE.

    `refonte` n'active pas Gemini par défaut (ses conditions d'usage le réservent aux plus de 18 ans) : seul Groq est appelé ici."""
    for essai in (1, 2):
        async with assistant._get_semaphore():
            texte = await assistant.call_cascade(prompt, [])
        if texte and texte.strip():
            return texte
        if essai == 1:
            log.info("Génération : aucune réponse, nouvel essai dans %.0f s", _pause_reessai())
            await asyncio.sleep(_pause_reessai())
    raise GenerationIndisponible()


def assembler_sujet(exercices: list[str], situation: str) -> str:
    return ("## PARTIE A : ÉVALUATION DES RESSOURCES (15 points)\n\n" + "\n\n".join(exercices)
            + "\n\n## PARTIE B : ÉVALUATION DES COMPÉTENCES (5 points)\n\n" + situation + "\n")


def _corps_exercice(k: int, pts: Fraction, texte: str) -> str:
    return f"### Exercice {k} ({formater_points(pts)} points)\n\n{_sans_titres_initiaux(texte)}"


def _corps_situation(texte: str) -> str:
    return "### Situation\n\n" + _sans_titres_initiaux(texte)


async def generer(meta: dict, theme: str, consignes: str, nb: int) -> AsyncIterator[dict]:
    """Événements : `{"type": "etape", "code", "n", "total", "k"?}` au début de chaque étape, puis soit
    `{"type": "resultat", "sujet", "corrige", "controles"}` soit `{"type": "erreur", "code"}`. Rien n'est enregistré."""
    # Les modèles de génération sont choisis dans `call_cascade` (GENERATION_GROQ_MODELS) : `refonte` n'a pas de ContextVar de surcharge.
    total = nb + 3
    n = 0

    def etape(code: str, **extra) -> dict:
        nonlocal n
        n += 1
        return {"type": "etape", "code": code, "n": min(n, total), "total": total, **extra}

    try:
        yield etape("plan")
        plan = lire_plan(await _appeler(prompt_plan(meta, theme, consignes, nb)), nb, theme)

        points = repartir_points(POINTS_PARTIE_A, nb)
        exercices: list[str] = []
        for k in range(1, nb + 1):
            yield etape("exercice", k=k)
            texte = await _appeler(prompt_exercice(meta, theme, consignes, k, points[k - 1], plan, [e["titre"] for e in plan["exercices"][: k - 1]]))
            exercices.append(_corps_exercice(k, points[k - 1], texte))

        yield etape("situation")
        situation = _corps_situation(await _appeler(prompt_situation(meta, theme, consignes, plan)))

        # une seule réparation par bloc dont le barème ne tombe pas juste (l'IA se trompe souvent d'un quart de point)
        for k in range(1, nb + 1):
            trouve = somme_points(exercices[k - 1].split("\n", 1)[1])
            if trouve != points[k - 1]:
                yield {"type": "etape", "code": "reparation", "n": n, "total": total, "k": k}
                consigne = (f"ta version précédente totalisait {formater_points(trouve)} points au lieu de {formater_points(points[k - 1])} : "
                            f"réécris l'exercice avec des barèmes dont la somme vaut exactement {formater_points(points[k - 1])}.")
                texte = await _appeler(prompt_exercice(meta, theme, consignes, k, points[k - 1], plan, [e["titre"] for e in plan["exercices"][: k - 1]], consigne))
                exercices[k - 1] = _corps_exercice(k, points[k - 1], texte)
        if somme_points(situation) != POINTS_PARTIE_B:
            yield {"type": "etape", "code": "reparation", "n": n, "total": total}
            consigne = (f"ta version précédente totalisait {formater_points(somme_points(situation))} points au lieu de {formater_points(POINTS_PARTIE_B)} : "
                        f"réécris la situation avec des barèmes dont la somme vaut exactement {formater_points(POINTS_PARTIE_B)}.")
            situation = _corps_situation(await _appeler(prompt_situation(meta, theme, consignes, plan, consigne)))

        sujet = assembler_sujet(exercices, situation)
        yield etape("corrige")
        corrige = _nettoyer(await _appeler(prompt_corrige(sujet))) + "\n"

        controles = controles_sujet(sujet, nb) + controles_corrige(corrige, nb)
        yield {"type": "resultat", "sujet": sujet, "corrige": corrige, "controles": controles}
    except GenerationIndisponible:
        yield {"type": "erreur", "code": "indisponible", "etape": n}
    except Exception as exc:  # noqa: BLE001 — l'admin doit voir une erreur franche, jamais un flux muet
        log.exception("Génération d'exercices : erreur inattendue : %s", exc)
        yield {"type": "erreur", "code": "interne", "etape": n}
