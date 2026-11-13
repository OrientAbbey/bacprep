"""Entraînement : exercices générés à partir de GABARITS PARAMÉTRÉS validés
(voir `core/gabarits.py`). Public, sans jeton, sans IA.

Un gabarit n'est visible que s'il est VALIDÉ par un enseignant pour son contenu
actuel (table `gabarit_validations`, liée au hash). L'énoncé et la correction
sont servis par deux appels distincts : la première réponse ne contient jamais
les réponses. Le couple (gabarit, graine) retrouve exactement la même variante
(c'est ce qui rend un signalement exploitable)."""
from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core import gabarits as gab
from ..core.rate_limit import SlidingWindowLimiter, client_ip
from ..db import get_db
from ..db_models import GabaritSignalementORM, GabaritValidationORM
from .auth import require_user

router = APIRouter(prefix="/api/entrainement", tags=["entrainement"])

# Calcul léger, mais public : plafond par adresse IP (mémoire, mono-instance).
_limiter = SlidingWindowLimiter(
    max_attempts=240,
    window_seconds=300.0,
    message="Trop de demandes d'exercices — réessaie dans quelques minutes",
    env_switch="ENTRAINEMENT_RATE_LIMIT",
)
_signal_limiter = SlidingWindowLimiter(
    max_attempts=10,
    window_seconds=3600.0,
    message="Trop de signalements — réessaie plus tard",
    env_switch="ENTRAINEMENT_RATE_LIMIT",
)


def gabarits_valides(db: Session) -> dict[str, gab.Gabarit]:
    """Gabarits chargés ET validés pour leur contenu actuel."""
    tous, _ = gab.tous()
    validations = {v.gabarit_id: v.hash_contenu for v in db.query(GabaritValidationORM).all()}
    return {gid: g for gid, g in tous.items() if validations.get(gid) == g.hash}


def _valide_ou_404(db: Session, gabarit_id: str) -> gab.Gabarit:
    g = gabarits_valides(db).get(gabarit_id)
    if g is None:
        raise HTTPException(404, "Exercice introuvable")
    return g


def instancier_ou_500(g: gab.Gabarit, graine: int) -> dict:
    """Un gabarit validé ne devrait jamais échouer : on le dit franchement
    plutôt que d'afficher un énoncé faux."""
    try:
        return g.instancier(graine)
    except gab.GabaritError as exc:
        raise HTTPException(500, "Cet exercice est momentanément indisponible") from exc


@router.get("/gabarits")
def lister(request: Request, db: Session = Depends(get_db)) -> list[dict]:
    _limiter.check(client_ip(request))
    return sorted(
        (g.resume() for g in gabarits_valides(db).values()),
        key=lambda r: (r["matiere"], r["chapitre"], r["difficulte"], r["titre"]),
    )


@router.get("/gabarits/{gabarit_id}")
def variante(
    gabarit_id: str,
    request: Request,
    graine: int | None = Query(default=None, ge=0, le=gab.GRAINE_MAX),
    db: Session = Depends(get_db),
) -> dict:
    """Une variante SANS ses réponses. Sans `graine`, le serveur en tire une et
    la rend (pour pouvoir la partager ou la signaler)."""
    _limiter.check(client_ip(request))
    g = _valide_ou_404(db, gabarit_id)
    graine = secrets.randbelow(gab.GRAINE_MAX + 1) if graine is None else graine
    return gab.vue_eleve(instancier_ou_500(g, graine))


@router.get("/gabarits/{gabarit_id}/correction")
def correction(
    gabarit_id: str,
    request: Request,
    graine: int = Query(ge=0, le=gab.GRAINE_MAX),
    db: Session = Depends(get_db),
) -> dict:
    _limiter.check(client_ip(request))
    g = _valide_ou_404(db, gabarit_id)
    return gab.vue_correction(instancier_ou_500(g, graine))


class SignalementIn(BaseModel):
    graine: int = Field(ge=0, le=gab.GRAINE_MAX)
    message: str = Field(default="", max_length=1000)


@router.post("/gabarits/{gabarit_id}/signalements")
def signaler(gabarit_id: str, payload: SignalementIn, db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """Signale une variante fautive (énoncé faux, correction fausse, hors
    programme…). Un seul signalement ouvert par élève et par variante."""
    _signal_limiter.check(user.id)
    _valide_ou_404(db, gabarit_id)
    deja = (
        db.query(GabaritSignalementORM)
        .filter(
            GabaritSignalementORM.user_id == user.id,
            GabaritSignalementORM.gabarit_id == gabarit_id,
            GabaritSignalementORM.graine == payload.graine,
            GabaritSignalementORM.statut == "ouvert",
        )
        .first()
    )
    if deja:
        raise HTTPException(409, "Tu as déjà signalé cette variante — elle est en attente de traitement.")
    row = GabaritSignalementORM(gabarit_id=gabarit_id, graine=payload.graine, user_id=user.id, message=payload.message.strip())
    db.add(row)
    db.commit()
    return {"ok": True, "id": row.id}
