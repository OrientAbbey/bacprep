"""Contexte transmis à l'assistant élève : jamais cru tel quel.

Le client envoie le passage sélectionné (ou l'épreuve entière). Sans contrôle,
n'importe quel texte pouvait servir de « contexte » (instructions injectées,
assistant utilisé comme IA généraliste aux frais du site). On vérifie que ce
texte provient bien de l'épreuve ; sinon on le remplace par le contenu réel."""
from __future__ import annotations

import re

from sqlalchemy.orm import Session

from ..db import _fold_for_search
from ..db_models import EpreuveORM
from . import epreuve_files

MAX_CONTEXTE = 20000  # identique au plafond d'AskIn.contexte
SEUIL_MOTS = 0.6  # part minimale des mots du passage retrouvés dans l'épreuve


def _mots(texte: str) -> set[str]:
    return set(re.findall(r"[a-z]{4,}", _fold_for_search(texte)))


def contexte_serveur(db: Session, epreuve: EpreuveORM) -> str:
    """Sujet puis corrigé de l'épreuve, tels que stockés (tronqués au plafond)."""
    indices = sorted({f.sujet_index for f in epreuve.files_rel if f.format == "md"}) or [0]
    morceaux = []
    for i in indices:
        for cible in ("sujet", "corrige"):
            texte = epreuve_files.read_document_content(db, epreuve.id, cible, i)
            if texte:
                morceaux.append(f"[{cible} {i + 1}]\n{texte}")
    return "\n\n".join(morceaux)[:MAX_CONTEXTE]


def contexte_verifie(db: Session, epreuve: EpreuveORM, contexte_client: str) -> str:
    """Le contexte du client s'il provient de l'épreuve, sinon le contenu réel."""
    source = contexte_serveur(db, epreuve)
    if not contexte_client.strip():
        return source
    mots = _mots(contexte_client)
    if not mots:
        return source
    if len(mots & _mots(source)) / len(mots) >= SEUIL_MOTS:
        return contexte_client
    return source
