"""Atelier d'exercices : `POST /api/admin/generation-exercices` en Server-Sent Events, réservée aux sessions admin.

Génère un BROUILLON (sujet + corrigé + contrôles) renvoyé à l'éditeur ; RIEN n'est enregistré ni publié ici (voir core/generation_exercices.py).
Événements : `etape` (progression), puis `resultat` ou `erreur`. Refusé (409) si l'épreuve indiquée est déjà publiée."""
from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..core import assistant, generation_exercices as gen
from ..core.logging_config import get_logger
from ..core.rate_limit import SlidingWindowLimiter, client_ip
from ..db import get_db
from ..db_models import EpreuveORM
from .deps import log_admin_event, require_admin

router = APIRouter(prefix="/api/admin", tags=["admin-generation"])
log = get_logger("admin_generation")

# Une génération coûte 5 à 8 appels au fournisseur : plafond bien plus bas que celui de l'assistant (mémoire, mono-instance).
_gen_limiter = SlidingWindowLimiter(
    max_attempts=6,
    window_seconds=600.0,
    message="Trop de demandes à l'assistant — réessaie dans quelques minutes",
    env_switch="ASSISTANT_RATE_LIMIT",
)


class MetaIn(BaseModel):
    matiere: str = Field(default="", max_length=120)
    classe: str = Field(default="", max_length=60)
    evaluation: str = Field(default="", max_length=80)
    filieres: list[str] = Field(default_factory=list, max_length=12)


class GenerationIn(BaseModel):
    theme: str = Field(min_length=3, max_length=300)
    nb_exercices: int = Field(default=3, ge=gen.NB_EXERCICES_MIN, le=gen.NB_EXERCICES_MAX)
    consignes: str = Field(default="", max_length=500)
    epreuve_id: Optional[str] = Field(default=None, max_length=64)
    meta: MetaIn = Field(default_factory=MetaIn)


def _sse(evenement: dict) -> str:
    return f"data: {json.dumps(evenement, ensure_ascii=False)}\n\n"


@router.post("/generation-exercices")
async def generer_exercices(payload: GenerationIn, request: Request, db: Session = Depends(get_db), lock=Depends(require_admin)):
    _gen_limiter.check(f"{lock.email}|{client_ip(request)}")
    if payload.epreuve_id:
        ep = db.get(EpreuveORM, payload.epreuve_id)
        if ep is not None and ep.statut == "publie":
            raise HTTPException(409, "Cette épreuve est déjà publiée : le texte généré par une IA doit d'abord être relu. Génère dans un brouillon.")
    if not assistant.cle_ia_configuree():
        raise HTTPException(503, "Aucun fournisseur d'IA n'est configuré : la génération d'exercices est indisponible.")

    meta = payload.meta.model_dump()
    email, epreuve_id = lock.email, payload.epreuve_id

    async def flux():
        assistant._nouvelle_mesure()
        try:
            async for evenement in gen.generer(meta, payload.theme.strip(), payload.consignes.strip(), payload.nb_exercices):
                if evenement["type"] == "resultat":
                    from ..db import SessionLocal

                    with SessionLocal() as audit_db:  # la session injectée peut être fermée quand le flux reprend
                        log_admin_event(audit_db, epreuve_id, "generation_exercices", email, {
                            "theme": payload.theme[:80], "nb_exercices": payload.nb_exercices,
                            "erreurs": sum(1 for c in evenement["controles"] if c["niveau"] == "erreur"),
                        })
                yield _sse(evenement)
        finally:
            assistant._enregistrer_mesure(None)

    return StreamingResponse(flux(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
