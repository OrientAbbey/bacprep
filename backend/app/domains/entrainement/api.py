"""Entraînement : exercices générés à partir de GABARITS PARAMÉTRÉS validés
(voir `core/gabarits.py`). Réservé aux comptes connectés, sans IA.

Un gabarit n'est visible que s'il est VALIDÉ par un enseignant pour son contenu
actuel (table `gabarit_validations`, liée au hash). L'énoncé et la correction
sont servis par deux appels distincts : la première réponse ne contient jamais
les réponses. Le couple (gabarit, graine) retrouve exactement la même variante
(c'est ce qui rend un signalement exploitable)."""
from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from ...core.rate_limit import SlidingWindowLimiter, client_ip
from ...db import get_db
from ...db_models import GabaritSignalementORM
from ...routers.auth import require_user
from . import moteur as gab
from .schemas import SignalementIn
from .use_cases import gabarit_valide_ou_404, gabarits_valides, instancier_ou_500

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


@router.get("/gabarits")
def lister(request: Request, db: Session = Depends(get_db), user=Depends(require_user)) -> list[dict]:
    """Liste les gabarits validés disponibles pour l'entraînement, triés par matière, chapitre et difficulté."""
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
    user=Depends(require_user),
) -> dict:
    """Une variante SANS ses réponses. Sans `graine`, le serveur en tire une et
    la rend (pour pouvoir la partager ou la signaler)."""
    _limiter.check(client_ip(request))
    g = gabarit_valide_ou_404(db, gabarit_id)
    graine = secrets.randbelow(gab.GRAINE_MAX + 1) if graine is None else graine
    return gab.vue_eleve(instancier_ou_500(g, graine))


@router.get("/gabarits/{gabarit_id}/correction")
def correction(
    gabarit_id: str,
    request: Request,
    graine: int = Query(ge=0, le=gab.GRAINE_MAX),
    db: Session = Depends(get_db),
    user=Depends(require_user),
) -> dict:
    """Renvoie la correction détaillée d'une variante validée, appelée séparément du sujet."""
    _limiter.check(client_ip(request))
    g = gabarit_valide_ou_404(db, gabarit_id)
    return gab.vue_correction(instancier_ou_500(g, graine))


@router.post("/gabarits/{gabarit_id}/signalements")
def signaler(gabarit_id: str, payload: SignalementIn, db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """Signale une variante fautive (énoncé faux, correction fausse, hors
    programme…). Un seul signalement ouvert par élève et par variante."""
    _signal_limiter.check(user.id)
    gabarit_valide_ou_404(db, gabarit_id)
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
