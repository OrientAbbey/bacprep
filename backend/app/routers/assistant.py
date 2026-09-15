from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from starlette.requests import ClientDisconnect

from ..core import store
from ..core.assistant import ask_assistant, ask_assistant_stream
from ..core.logging_config import get_logger
from ..core.rate_limit import SlidingWindowLimiter
from ..db import get_db, utc_now
from ..db_models import AIConversationORM
from ..models import AskIn, ConversationOut
from .auth import require_user
from .deps import get_epreuve_or_404, get_public_epreuve_or_404

router = APIRouter(prefix="/api/assistant", tags=["assistant"])
log = get_logger("assistant_router")

# Plafonne le coût LLM par utilisateur (l'assistant appelle des APIs
# payantes à la requête) — comptage mémoire, mono-instance (désactivable
# via ASSISTANT_RATE_LIMIT pour les tests).
_ask_limiter = SlidingWindowLimiter(
    max_attempts=20,
    window_seconds=300.0,
    message="Trop de questions à l'assistant — réessaie dans quelques minutes",
    env_switch="ASSISTANT_RATE_LIMIT",
)


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

    epreuve = get_epreuve_or_404(db, conv.epreuve_id)
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

    Garde consentement : voie persistée refusée (403) aux utilisateurs
    ayant refusé le stockage de leurs conversations IA (l'éphémère passe
    par `/ask/stream`)."""
    if user.consent_ia is False:
        raise HTTPException(403, "Tu as refusé le stockage de tes conversations IA — modifie ton choix dans ton profil.")
    conv, epreuve = _load_conversation_and_epreuve(db, user.id, payload.conversation_id)
    _ask_limiter.check(user.id)

    messages = json.loads(conv.messages_json or "[]")
    messages.append({"role": "user", "content": payload.message, "ts": utc_now().isoformat()})

    reponse = await ask_assistant(
        epreuve_meta={"matiere": epreuve.matiere, "annee": epreuve.annee, "filieres": epreuve.filieres},
        contexte=conv.contexte,
        question=payload.message,
        historique=messages,
        user_id=user.id,
    )
    messages.append({"role": "assistant", "content": reponse, "ts": utc_now().isoformat()})

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
    - `{"type": "done", "conversation": {...}|null}` — la discussion complète
      persistée (voie persistée), ou `null` (voie éphémère, rien n'est
      stocké) une fois le flux terminé ;
    - `{"type": "error", "message": "..."}` — en cas d'échec pendant le
      flux (après quoi la connexion se ferme).

    Deux voies exclusives (cf. `AskIn`) : PERSISTÉE (`conversation_id`, le
    message de l'élève est écrit IMMÉDIATEMENT pour ne jamais le perdre —
    exige le consentement IA) et ÉPHÉMÈRE (refus du consentement : l'élève
    garde sa discussion côté client, RIEN n'est persisté, ni à la question
    ni à la réponse)."""
    ephemere = payload.conversation_id is None
    if ephemere:
        if not payload.epreuve_id:
            raise HTTPException(400, "epreuve_id requis pour une question éphémère")
        epreuve = get_public_epreuve_or_404(db, payload.epreuve_id, user)
        _ask_limiter.check(user.id)
        contexte = payload.contexte
        # Historique borné côté client, réordonné par sécurité + question.
        messages = list(payload.historique)[-20:] + [{"role": "user", "content": payload.message}]
        conv_id = None
    else:
        if user.consent_ia is False:
            raise HTTPException(
                403, "Tu as refusé le stockage de tes conversations IA — modifie ton choix dans ton profil pour retrouver tes discussions."
            )
        conv, epreuve = _load_conversation_and_epreuve(db, user.id, payload.conversation_id)
        _ask_limiter.check(user.id)

        messages = json.loads(conv.messages_json or "[]")
        messages.append({"role": "user", "content": payload.message, "ts": utc_now().isoformat()})
        # Persistance IMMÉDIATE du message utilisateur (avant le streaming)
        # pour ne jamais le perdre si le flux échoue. La réponse assistant
        # sera écrite à la fin du flux dans event_stream() (double-écriture
        # intentionnelle : la seconde écrase la première avec les deux messages).
        conv = store.update_conversation(db, conv, messages)

        contexte = conv.contexte
        conv_id = conv.id

    epreuve_meta = {"matiere": epreuve.matiere, "annee": epreuve.annee, "filieres": epreuve.filieres}

    async def event_stream():
        """Générateur SSE : cède les fragments de texte au fur et à mesure,
        puis persiste (voie persistée uniquement) et cède l'état final de la
        discussion (voir docstring de `ask_stream` pour le format des
        évènements)."""
        accumulated = ""
        try:
            async for chunk in ask_assistant_stream(epreuve_meta, contexte, payload.message, messages, user_id=user.id):
                accumulated += chunk
                yield f"data: {json.dumps({'type': 'chunk', 'text': chunk}, ensure_ascii=False)}\n\n"
        except ClientDisconnect:
            # Fermeture de la page/onglet pendant le streaming : situation
            # normale, pas une erreur — sans ce cas en tête du except,
            # Starlette levait un traceback complet + un faux évènement
            # `error` à chaque déconnexion.
            log.debug("Client disconnect pendant le streaming (conversation=%s)", conv_id)
            return
        except Exception as exc:
            log.exception("Erreur pendant le streaming assistant (conversation=%s): %s", conv_id, exc)
            yield f"data: {json.dumps({'type': 'error', 'message': 'Une erreur est survenue côté serveur.'})}\n\n"
            return

        if ephemere:
            yield f"data: {json.dumps({'type': 'done', 'conversation': None})}\n\n"
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
            final_messages = messages + [{"role": "assistant", "content": accumulated, "ts": utc_now().isoformat()}]
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
