from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..core import store
from ..core.assistant import ask_assistant, ask_assistant_stream
from ..core.logging_config import get_logger
from ..db import get_db
from ..db_models import AIConversationORM, EpreuveORM
from ..models import AskIn, ConversationOut
from .auth import require_user

router = APIRouter(prefix="/api/assistant", tags=["assistant"])
log = get_logger("assistant_router")


def _load_conversation_and_epreuve(db: Session, user_id: str, conversation_id: str):
    """Charge la discussion (appartenant à cet utilisateur) et son épreuve,
    ou lève 404 — factorisé entre l'endpoint non-streaming et streaming."""
    conv = (
        db.query(AIConversationORM)
        .filter(AIConversationORM.id == conversation_id, AIConversationORM.user_id == user_id)
        .one_or_none()
    )
    if not conv:
        raise HTTPException(404, "Discussion introuvable")

    epreuve = db.query(EpreuveORM).filter(EpreuveORM.id == conv.epreuve_id).one_or_none()
    if not epreuve:
        raise HTTPException(404, "Épreuve introuvable")

    return conv, epreuve


@router.post("/ask", response_model=ConversationOut)
async def ask(payload: AskIn, db: Session = Depends(get_db), user=Depends(require_user)) -> ConversationOut:
    """Envoie une question de l'élève à l'assistant IA et attend la réponse
    complète avant de répondre (pas de streaming). Persiste l'échange
    (question + réponse) dans la discussion et retourne son état à jour.

    Conservé pour compatibilité / clients qui ne consomment pas de flux
    SSE ; le frontend utilise par défaut `/ask/stream` ci-dessous, qui
    affiche la réponse au fur et à mesure de sa génération.

    Le contexte utilisé est celui figé à la création de la discussion
    (`conv.contexte` — un passage précis sélectionné, ou vide pour
    "épreuve entière"), pas un contexte recalculé à chaque question.
    """
    conv, epreuve = _load_conversation_and_epreuve(db, user.id, payload.conversation_id)

    messages = json.loads(conv.messages_json or "[]")
    messages.append({"role": "user", "content": payload.message})

    reponse = await ask_assistant(
        epreuve_meta={"matiere": epreuve.matiere, "annee": epreuve.annee, "filieres": epreuve.filieres},
        contexte=conv.contexte,
        question=payload.message,
        historique=messages,
    )
    messages.append({"role": "assistant", "content": reponse})

    conv = store.update_conversation(db, conv, messages)
    return ConversationOut(**store.conversation_to_dict(conv))


@router.post("/ask/stream")
async def ask_stream(payload: AskIn, db: Session = Depends(get_db), user=Depends(require_user)) -> StreamingResponse:
    """Variante streaming de `/ask`, utilisée par défaut par le frontend
    (voir AssistantPanel.tsx) pour tout fournisseur qui la supporte
    (Gemini et Groq la supportent tous les deux — voir le module
    core/assistant.py pour le détail et une limite connue concernant la
    vérification de cette capacité).

    Réponse au format Server-Sent Events (`text/event-stream`), une ligne
    `data: <json>` par évènement :
    - `{"type": "chunk", "text": "..."}` — un fragment de texte à ajouter
      au message assistant affiché ;
    - `{"type": "done", "conversation": {...}}` — la discussion complète,
      telle que persistée en base, une fois le flux terminé (mêmes champs
      que `ConversationOut`) ;
    - `{"type": "error", "message": "..."}` — en cas d'échec pendant le
      flux (après quoi la connexion se ferme).

    Le message de l'élève est persisté IMMÉDIATEMENT (avant de commencer à
    streamer la réponse), pour ne jamais le perdre même si le flux est
    interrompu en cours de route. Le message de l'assistant, lui, n'est
    persisté qu'une fois le flux terminé (texte accumulé complet).
    """
    conv, epreuve = _load_conversation_and_epreuve(db, user.id, payload.conversation_id)

    messages = json.loads(conv.messages_json or "[]")
    messages.append({"role": "user", "content": payload.message})
    conv = store.update_conversation(db, conv, messages)

    epreuve_meta = {"matiere": epreuve.matiere, "annee": epreuve.annee, "filieres": epreuve.filieres}
    contexte = conv.contexte
    conv_id = conv.id

    async def event_stream():
        """Générateur SSE : cède les fragments de texte au fur et à mesure,
        puis persiste et cède l'état final de la discussion (voir
        docstring de `ask_stream` pour le format des évènements)."""
        accumulated = ""
        try:
            async for chunk in ask_assistant_stream(epreuve_meta, contexte, payload.message, messages):
                accumulated += chunk
                yield f"data: {json.dumps({'type': 'chunk', 'text': chunk}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            log.exception("Erreur pendant le streaming assistant (conversation=%s): %s", conv_id, exc)
            yield f"data: {json.dumps({'type': 'error', 'message': 'Une erreur est survenue côté serveur.'})}\n\n"
            return

        # Nouvelle session DB : celle injectée par Depends(get_db) peut déjà
        # avoir été fermée selon le moment où ce générateur reprend la main
        # après le dernier `yield` ci-dessus (le corps de la réponse est
        # streamé après le retour de la fonction de route). On rouvre donc
        # une session dédiée pour la persistance finale plutôt que de
        # risquer d'utiliser une session déjà fermée.
        from ..db import SessionLocal

        local_db = SessionLocal()
        try:
            fresh_conv = local_db.query(AIConversationORM).filter(AIConversationORM.id == conv_id).one_or_none()
            if fresh_conv is None:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Discussion introuvable (supprimée entre-temps).'})}\n\n"
                return
            final_messages = messages + [{"role": "assistant", "content": accumulated}]
            updated = store.update_conversation(local_db, fresh_conv, final_messages)
            out = jsonable_encoder(store.conversation_to_dict(updated))
            yield f"data: {json.dumps({'type': 'done', 'conversation': out}, ensure_ascii=False)}\n\n"
        finally:
            local_db.close()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
