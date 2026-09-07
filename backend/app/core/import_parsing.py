"""Parsing heuristique des chemins d'import massif — pur (ni base, ni
stockage, ni I/O), testable unitairement.

Format attendu du dossier importé (tolérant) :

```
{annee}/{classe}/{matiere}/**   (un niveau racine optionnel est ignoré)
```

ex. ``imports/2023/Terminale/Mathématiques/bac-D-sujet.md``.
Chaque segment est identifié par sa nature (année, classe, niveau,
matière) plutôt que par sa position ; les heuristiques de nom de fichier
complètent (série, évaluation, sujet/corrigé).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from . import referentiel

_ANNEE_RE = re.compile(r"^(19|20)\d{2}$")
_CORRIGE_RE = re.compile(r"corrig[eé]|answer", re.IGNORECASE)
_SERIE_RE = re.compile(r"(?:serie|série|bac)\s*[:\- ]?\s*([A-Z])\b", re.IGNORECASE)


def _fold(value: str) -> str:
    return referentiel.fold(value)


def guess_cible(path: Path) -> str:
    """Sujet ou corrigé selon le nom du fichier ("corrige..." → corrigé)."""
    return "corrige" if _CORRIGE_RE.search(path.stem) else "sujet"


def guess_serie(text: str) -> Optional[str]:
    m = _SERIE_RE.search(text or "")
    return m.group(1).upper() if m else None


def _match_matiere(segment: str) -> Optional[str]:
    """Reconnaît une matière connue (comparaison insensible casse/accents)
    dans un segment de chemin — évite de prendre un nom de dossier
    quelconque pour une matière."""
    folded = _fold(segment)
    for matiere in referentiel.MATIERES_CONNUES:
        if folded == _fold(matiere):
            return matiere
    return None


def guess_evaluation(text: str) -> Optional[str]:
    """Détecte l'évaluation mentionnée dans un texte de chemin/nom de
    fichier : mots entiers pour les évaluations simples, motifs tolérants
    (espaces/dashes optionnels) pour les séquences et compositions."""
    folded = _fold(text or "")
    if not folded:
        return None
    simple = {
        r"\bb\.?ac\b": "BAC",
        r"\bbepc\b": "BEPC",
        r"\bprobatoire\b": "PROBATOIRE",
        r"\bcep\b": "CEP",
        r"\bconcours\b": "CONCOURS",
    }
    for pattern, code in simple.items():
        if re.search(pattern, folded):
            return code
    if re.search(r"sequence\s*0?1", folded):
        return "SEQUENCE 1"
    if re.search(r"sequence\s*0?2", folded):
        return "SEQUENCE 2"
    if re.search(r"sequence\s*0?3", folded):
        return "SEQUENCE 3"
    if re.search(r"composition\s*trimest", folded):
        return "COMPOSITION TRIMESTRIELLE"
    if re.search(r"examen\s*blanc", folded):
        return "EXAMEN BLANC"
    return None


def parse_path(path: Path, root: Path) -> dict:
    """Extrait les métadonnées d'un fichier depuis son chemin relatif et son
    nom. Retourne un dict de champs trouvés + la liste des informations
    manquantes."""
    rel = path.relative_to(root)
    parts = [p for p in rel.parts[:-1]]  # dossiers parents (hors nom de fichier)

    annee = None
    classe = None
    matiere = None
    niveau = referentiel.NIVEAU_SECONDAIRE

    # Passe 1 : segments non ambigus (année, niveau, classe, matière connue)
    restants: list[str] = []
    for part in parts:
        part = part.strip()
        if _ANNEE_RE.match(part):
            annee = annee or part
            continue
        if _fold(part) in ("primaire", "secondaire"):
            niveau = referentiel.normalize_niveau(part)
            continue
        normalized_classe = referentiel.normalize_classe(part)
        if normalized_classe and not classe:
            classe = normalized_classe
            continue
        restants.append(part)

    # Passe 2 : matière — priorité aux matières CONNUES, puis le segment
    # suivant la classe (convention {annee}/{classe}/{matiere}), puis le
    # dernier segment restant.
    for part in restants:
        known = _match_matiere(part)
        if known:
            matiere = known
            break
    if not matiere and classe:
        # segment immédiatement après la classe dans le chemin original
        try:
            idx = next(i for i, p in enumerate(parts) if referentiel.normalize_classe(p))
            if idx + 1 < len(parts):
                matiere = parts[idx + 1].strip() or None
        except StopIteration:
            pass
    if not matiere and restants:
        matiere = restants[-1].strip() or None

    filename_parts = path.stem
    serie = guess_serie(filename_parts) or next(
        (s for s in (guess_serie(p) for p in parts) if s), None
    )
    if not matiere:
        # "maths_2023" → "maths" : retire l'année en fin de nom de fichier
        matiere = re.sub(r"[_\- ]?(19|20)\d{2}$", "", filename_parts).strip() or None

    evaluation = guess_evaluation(" ".join(parts)) or guess_evaluation(filename_parts)

    manquants = []
    if not annee:
        manquants.append("annee")
    if not classe:
        manquants.append("classe")
    if not matiere:
        manquants.append("matiere")

    return {
        "niveau": niveau,
        "annee": annee,
        "classe": classe,
        "matiere": matiere,
        "serie": serie,
        "evaluation": evaluation,
        "cible": guess_cible(path),
        "manquants": manquants,
    }
