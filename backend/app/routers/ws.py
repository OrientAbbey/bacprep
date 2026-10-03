from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from ..core import store
from ..core.logging_config import get_logger
from ..db import SessionLocal

router = APIRouter(tags=["ws"])
log = get_logger("ws")

# Plafond de connexions simultanées par utilisateur : plusieurs onglets
# sont légitimes, un millier de sockets ouverts par un même compte ne
# l'est pas — au-delà, la plus ancienne connexion est fermée.
MAX_WEBSOCKETS_PAR_USER = 3


def _resolve_user_from_cookie(cookie_header: str) -> str | None:
    """Extrait le jeton de session (`bacprep_session`) d'un en-tête Cookie
    brut. La librairie WebSocket de Starlette ne parse pas les cookies pour
    nous comme le fait une route HTTP classique (`Cookie(default=None)`) —
    on s'appuie donc sur `http.cookies.SimpleCookie` (gère les guillemets,
    les espaces et les points-virgules) plutôt que sur un découpage manuel."""
    import http.cookies

    if not cookie_header:
        return None
    try:
        jar = http.cookies.SimpleCookie(cookie_header)
        morsel = jar.get("bacprep_session")
        return morsel.value if morsel else None
    except http.cookies.CookieError:
        return None


def _origine_autorisee(origin: str, host: str) -> bool:
    import os
    from urllib.parse import urlparse

    if urlparse(origin).netloc == host:
        return True
    return origin in {o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")}


@router.websocket("/ws/session")
async def ws_session(websocket: WebSocket) -> None:
    """Connexion WebSocket persistante par utilisateur connecté, utilisée
    uniquement pour pousser la notification de kick-out en temps réel
    (voir Module 9 du cahier des charges) — ne traite aucune commande
    entrante, `receive_text()` sert juste à garder la connexion ouverte et
    à détecter la déconnexion. Le frontend gère la reconnexion automatique
    avec délai croissant côté client (AuthProvider)."""
    # Contrôle d'Origin : un site tiers ne doit pas pouvoir ouvrir ce socket
    # avec les cookies de l'utilisateur. Origin absent (client non-navigateur)
    # → accepté, le cookie de session reste exigé ci-dessous.
    origin = websocket.headers.get("origin", "")
    if origin and not _origine_autorisee(origin, websocket.headers.get("host", "")):
        await websocket.close(code=4403)
        return

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
    conns = store.ACTIVE_WEBSOCKETS.setdefault(user.id, [])
    conns.append(websocket)
    while len(conns) > MAX_WEBSOCKETS_PAR_USER:
        oldest = conns.pop(0)
        try:
            await oldest.close(code=4429)
        except Exception:
            pass
    log.info("WebSocket connecté pour user_id=%s", user.id)

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        conns = store.ACTIVE_WEBSOCKETS.get(user.id) or []
        if websocket in conns:
            conns.remove(websocket)
        if not conns:
            store.ACTIVE_WEBSOCKETS.pop(user.id, None)
        log.info("WebSocket déconnecté pour user_id=%s", user.id)
