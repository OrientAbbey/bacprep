"""Route assistant du back-office : `POST /api/admin/assistant/ask` en
Server-Sent Events (SSE), réservée aux sessions admin.

Conversations ÉPHÉMÈRES : le serveur ne persiste RIEN — pas de table, pas
de session ; l'événement final `done` porte `conversation: null`. Le
contexte de chaque question est l'instantané du formulaire envoyé par
`AdminAssistantPanel` (métadonnées + sujet + corrigé saisis).
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from starlette.requests import ClientDisconnect

from ..core.admin_assistant import ask_admin_assistant_stream
from ..core.logging_config import get_logger
from ..core.rate_limit import SlidingWindowLimiter, client_ip
from .deps import require_admin

router = APIRouter(prefix="/api/admin/assistant", tags=["admin-assistant"])
log = get_logger("admin_assistant_router")

# Plafonne le coût LLM par admin (les APIs appelées sont payantes) —
# comptage mémoire, mono-instance ; partage l'interrupteur
# ASSISTANT_RATE_LIMIT (désactivé en test).
_ask_limiter = SlidingWindowLimiter(
    max_attempts=30,
    window_seconds=300.0,
    message="Trop de demandes à l'assistant — réessaie dans quelques minutes",
    env_switch="ASSISTANT_RATE_LIMIT",
)


class AdminAskIn(BaseModel):
    """Question de l'admin + instantané du formulaire épreuve en cours.

    `epreuve` suit la forme du formulaire d'édition (AdminForm) :
    niveau, classe, evaluation, matiere, annee, session, duree, coefficient,
    gratuit, statut, filieres, contenu_markdown, corrige_markdown — les clés
    absentes sont tolérées (`build_admin_prompt` retombe sur « ? »)."""

    question: str = Field(min_length=1, max_length=8000)
    historique: list[dict] = Field(default_factory=list)
    epreuve: dict = Field(default_factory=dict)

    @field_validator("question")
    @classmethod
    def question_non_blanche(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("la question ne peut pas être vide")
        return v


@router.post("/ask")
async def admin_ask(payload: AdminAskIn, request: Request, lock=Depends(require_admin)) -> StreamingResponse:
    """Réponse streamée de l'assistant admin (mêmes événements que
    l'assistant élève `/api/assistant/ask/stream`, une ligne
    `data: <json>` par fragment) :

    - `{"type": "chunk", "text": "..."}` — un fragment de texte ;
    - `{"type": "done", "conversation": null}` — fin normale du flux
      (éphémère : RIEN n'est persisté) ;
    - `{"type": "error", "message": "..."}` — échec pendant le flux, la
      connexion se ferme ensuite.

    Rate-limit par admin/IP ; aucune écriture en base (pas de journal
    d'audit : rien n'est muté — les annotations d'une épreuve ne se font
    qu'à sa sauvegarde réelle par l'admin)."""
    _ask_limiter.check(f"{lock.email}|{client_ip(request)}")
    messages = list(payload.historique)[-20:] + [{"role": "user", "content": payload.question}]

    async def event_stream():
        try:
            async for chunk in ask_admin_assistant_stream(payload.epreuve, payload.question, messages):
                yield f"data: {json.dumps({'type': 'chunk', 'text': chunk}, ensure_ascii=False)}\n\n"
        except ClientDisconnect:
            log.debug("Client disconnect pendant le streaming assistant admin")
            return
        except Exception as exc:
            log.exception("Erreur pendant le streaming assistant admin: %s", exc)
            yield f"data: {json.dumps({'type': 'error', 'message': 'Une erreur est survenue côté serveur.'})}\n\n"
            return
        yield f"data: {json.dumps({'type': 'done', 'conversation': None})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )