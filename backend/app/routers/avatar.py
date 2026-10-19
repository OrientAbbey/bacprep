"""Photo de profil : envoi, lecture et suppression (compte connecté)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from sqlalchemy.orm import Session

from ..core.images import InvalidImageError, process_avatar
from ..core.rate_limit import SlidingWindowLimiter
from ..db import get_db, utc_now
from ..db_models import AvatarORM
from .auth import require_user

router = APIRouter(prefix="/api/me/avatar", tags=["avatar"])

MAX_OCTETS = 2 * 1024 * 1024  # photo brute envoyée ; l'avatar stocké fait ~15 Ko
# Le décodage d'image coûte du CPU : 10 envois par heure et par compte suffisent.
_limiteur = SlidingWindowLimiter(
    max_attempts=10, window_seconds=3600.0, message="Trop d'envois de photo — réessaie plus tard", env_switch="LOGIN_RATE_LIMIT"
)


@router.get("")
def lire(request: Request, db: Session = Depends(get_db), user=Depends(require_user)) -> Response:
    av = db.get(AvatarORM, user.id)
    if av is None:
        raise HTTPException(404, "Pas de photo de profil")
    etag = f'"{av.updated_at.timestamp():.0f}"'
    entetes = {"ETag": etag, "Cache-Control": "private, max-age=604800"}  # l'URL porte ?v= : changer de photo change l'URL
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=entetes)
    return Response(content=av.data, media_type="image/webp", headers=entetes)


@router.post("")
async def envoyer(file: UploadFile = File(...), db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    _limiteur.check(user.id)
    brut = await file.read(MAX_OCTETS + 1)
    if len(brut) > MAX_OCTETS:
        raise HTTPException(413, "Photo trop lourde (2 Mo maximum)")
    try:
        data = process_avatar(brut)
    except InvalidImageError:
        raise HTTPException(415, "Fichier non reconnu comme image (PNG, JPEG, WebP ou GIF)")
    av = db.get(AvatarORM, user.id)
    if av is None:
        av = AvatarORM(user_id=user.id, data=data)
        db.add(av)
    av.data, av.updated_at = data, utc_now()
    db.commit()
    return {"avatar_version": av.updated_at.isoformat()}


@router.delete("")
def supprimer(db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    db.query(AvatarORM).filter(AvatarORM.user_id == user.id).delete()
    db.commit()
    return {"ok": True}
