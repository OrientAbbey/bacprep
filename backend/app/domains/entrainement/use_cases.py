"""Cas d'usage du domaine Entraînement.

La logique est séparée des routes : les mêmes fonctions servent à la liste
élève, à l'aperçu admin et aux Flux SSE, sans dépendre de ``Request``.
"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ...db_models import GabaritValidationORM
from . import moteur as gab


def gabarits_valides(db: Session) -> dict[str, gab.Gabarit]:
    """Gabarits chargés ET validés pour leur contenu actuel."""
    tous, _ = gab.tous()
    validations = {v.gabarit_id: v.hash_contenu for v in db.query(GabaritValidationORM).all()}
    return {gid: g for gid, g in tous.items() if validations.get(gid) == g.hash}


def gabarit_valide_ou_404(db: Session, gabarit_id: str) -> gab.Gabarit:
    """Résout un gabarit public ou lève 404 (un gabarit non validé est invisible)."""
    g = gabarits_valides(db).get(gabarit_id)
    if g is None:
        raise HTTPException(404, "Exercice introuvable")
    return g


def instancier_ou_500(gabarit: gab.Gabarit, graine: int) -> dict:
    """Un gabarit validé ne devrait jamais échouer : on le dit franchement
    plutôt que d'afficher un énoncé faux."""
    try:
        return gabarit.instancier(graine)
    except gab.GabaritError as exc:
        raise HTTPException(500, "Cet exercice est momentanément indisponible") from exc
