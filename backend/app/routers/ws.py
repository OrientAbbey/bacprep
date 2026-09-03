from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from ..core import store
from ..core.logging_config import get_logger
from ..db import SessionLocal

router = APIRouter(tags=["ws"])
log = get_logger("ws")


def _resolve_user_from_cookie(cookie_header: str) -> str | None:
    """Extrait le jeton de session (`bacprep_session`) d'un en-tête Cookie
    brut. Nécessaire car la librairie WebSocket de Starlette ne parse pas
    les cookies pour nous comme le fait une route HTTP classique
    (`Cookie(default=None)`)."""
    if not cookie_header:
        return None
    for part in cookie_header.split(";"):
        part = part.strip()
        if part.startswith("bacprep_session="):
            return part.split("=", 1)[1]
    return None


@router.websocket("/ws/session")
async def ws_session(websocket: WebSocket) -> None:
    """Connexion WebSocket persistante par utilisateur connecté, utilisée
    uniquement pour pousser la notification de kick-out en temps réel
    (voir Module 9 du cahier des charges) — ne traite aucune commande
    entrante, `receive_text()` sert juste à garder la connexion ouverte et
    à détecter la déconnexion. Le frontend gère la reconnexion automatique
    avec délai croissant côté client (AuthProvider)."""
    cookie_header = websocket.headers.get("cookie", "")
    token = _resolve_user_from_cookie(cookie_header)

    db: Session = SessionLocal()
    try:
        user = store.resolve_session(db, token or "")
    finally:
        db.close()

    if not user:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    store.ACTIVE_WEBSOCKETS[user.id] = websocket
    log.info("WebSocket connecté pour user_id=%s", user.id)

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if store.ACTIVE_WEBSOCKETS.get(user.id) is websocket:
            del store.ACTIVE_WEBSOCKETS[user.id]
        log.info("WebSocket déconnecté pour user_id=%s", user.id)
