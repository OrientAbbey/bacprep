"""Route assistant du back-office : `POST /api/admin/assistant/ask` en
Server-Sent Events (SSE), réservée aux sessions admin.

Deux voies (mêmes événements que l'assistant élève) :

- PERSISTÉE : `epreuve_id` présent — la conversation « roulante » de cet
  admin sur cette épreuve est relue/recréée, le message de l'admin est
  écrit IMMÉDIATEMENT (jamais perdu), et l'événement final `done` porte
  l'objet conversation persisté. Chaque tentative renvoie une charge utile
  IDENTIQUE : le serveur réconcilie au préalable les messages persistés
  avec l'`historique` de la charge (le résidu d'une tentative interrompue
  n'est jamais dupliqué) — même convention que l'assistant élève.
- ÉPHÉMÈRE : sans `epreuve_id` (épreuve pas encore enregistrée) — rien
  n'est persisté, `done` porte `conversation: null`.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session
from starlette.requests import ClientDisconnect

from ..core.admin_assistant import ask_admin_assistant_stream
from ..core.logging_config import get_logger
from ..core.rate_limit import SlidingWindowLimiter, client_ip
from ..core import store
from ..db import get_db, utc_now
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
    niveau, classe, evaluation, matiere, annee, duree, coefficient,
    gratuit, statut, filieres, contenu_markdown, corrige_markdown — les clés
    absentes sont tolérées (`build_admin_prompt` retombe sur « ? »).

    `epreuve_id` (id de l'épreuve EN SAVEGARDE) déclenche la persistance de
    la conversation ; absent (épreuve pas encore enregistrée), l'échange est
    éphémère. `historique` = l'état des messages attendu par le client (base
    de réconciliation)."""

    question: str = Field(min_length=1, max_length=8000)
    historique: list[dict] = Field(default_factory=list)
    epreuve: dict = Field(default_factory=dict)
    epreuve_id: str | None = Field(default=None, max_length=64)

    @field_validator("question")
    @classmethod
    def question_non_blanche(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("la question ne peut pas être vide")
        return v


def _historique_borne(historique: list[dict]) -> list[dict]:
    """Historique borné (20 derniers messages) et réordonné par sécurité."""
    return list(historique)[-20:]


@router.get("/conversation/{epreuve_id}")
def admin_get_conversation(
    epreuve_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)
) -> dict:
    """Charge la conversation roulante de CET admin sur cette épreuve (id
    des messages inclus) pour restaurer le tiroir à la réouverture. Null si
    aucune discussion n'existe encore."""
    conv = store.get_admin_conversation(db, lock.email, epreuve_id)
    return {"conversation": store.admin_conversation_to_dict(conv) if conv else None}


@router.delete("/conversation/{epreuve_id}")
def admin_delete_conversation(
    epreuve_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)
) -> dict:
    """« Nouvelle conversation » : supprime la conversation de cet admin sur
    cette épreuve (le prochain `/ask` la recrée vierge)."""
    conv = store.get_admin_conversation(db, lock.email, epreuve_id)
    if conv:
        store.delete_admin_conversation(db, conv)
    return {"ok": True}


@router.post("/ask")
async def admin_ask(payload: AdminAskIn, request: Request, lock=Depends(require_admin), db: Session = Depends(get_db)) -> StreamingResponse:
    """Réponse streamée de l'assistant admin (mêmes événements que
    l'assistant élève `/api/assistant/ask/stream`, une ligne
    `data: <json>` par fragment) :

    - `{"type": "chunk", "text": "..."}` — un fragment de texte ;
    - `{"type": "done", "conversation": {...}|null}` — fin normale du flux
      (conversation persistée si `epreuve_id` fourni, sinon null) ;
    - `{"type": "error", "message": "..."}` — échec pendant le flux, la
      connexion se ferme ensuite.

    Rate-limit par admin/IP ; les échanges ne sont écrits en base QUE sur
    la voie persistée (jamais de journal d'audit : les annotations d'une
    épreuve ne se font qu'à sa sauvegarde réelle par l'admin)."""
    _ask_limiter.check(f"{lock.email}|{client_ip(request)}")

    persiste = bool(payload.epreuve_id)
    conv = None
    if persiste:
        conv = store.get_admin_conversation(db, lock.email, payload.epreuve_id)
        if not conv:
            conv = store.create_admin_conversation(db, lock.email, payload.epreuve_id)
        # Réconciliation : ramène les messages persistés à l'`historique`
        # attendu par le client (base) — le résidu d'une tentative
        # interrompue ne doit pas être dupliqué par une réémission.
        attendus = _historique_borne(payload.historique)
        if json.loads(conv.messages_json or "[]") != attendus:
            conv = store.update_admin_conversation(db, conv, attendus)
        messages = attendus + [{"role": "user", "content": payload.question, "ts": utc_now().isoformat()}]
        # Persistance IMMÉDIATE du message de l'admin (avant le streaming)
        # pour ne jamais le perdre si le flux échoue ; la réponse sera
        # écrite à la fin dans event_stream() (la seconde écriture écrase la
        # première avec les deux messages).
        conv = store.update_admin_conversation(db, conv, messages)
    else:
        messages = _historique_borne(payload.historique) + [{"role": "user", "content": payload.question}]

    conv_id = conv.id if conv else None

    async def event_stream():
        accumulated = ""
        try:
            async for chunk in ask_admin_assistant_stream(payload.epreuve, payload.question, messages):
                accumulated += chunk
                yield f"data: {json.dumps({'type': 'chunk', 'text': chunk}, ensure_ascii=False)}\n\n"
        except ClientDisconnect:
            log.debug("Client disconnect pendant le streaming assistant admin (conversation=%s)", conv_id)
            return
        except Exception as exc:
            log.exception("Erreur pendant le streaming assistant admin: %s", exc)
            yield f"data: {json.dumps({'type': 'error', 'message': 'Une erreur est survenue côté serveur.'})}\n\n"
            return

        if not persiste or conv_id is None:
            yield f"data: {json.dumps({'type': 'done', 'conversation': None})}\n\n"
            return

        # Nouvelle session DB : celle injectée peut déjà être fermée quand le
        # générateur reprend après son dernier `yield` (le corps de la réponse
        # est streamé après le retour de la route).
        from ..db import SessionLocal

        local_db = SessionLocal()
        try:
            fresh_conv = store.get_admin_conversation(local_db, lock.email, payload.epreuve_id)
            if fresh_conv is None:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Discussion introuvable (supprimée entre-temps).'})}\n\n"
                return
            final_messages = messages + [{"role": "assistant", "content": accumulated, "ts": utc_now().isoformat()}]
            updated = store.update_admin_conversation(local_db, fresh_conv, final_messages)
            out = store.admin_conversation_to_dict(updated)
            yield f"data: {json.dumps({'type': 'done', 'conversation': out}, ensure_ascii=False)}\n\n"
        finally:
            local_db.close()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )