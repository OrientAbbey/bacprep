"""Lecture de la version de la photo de profil (module neutre : importé par les routeurs auth et avatar)."""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..db_models import AvatarORM


def version_avatar(db: Session, user_id: str) -> str | None:
    """Horodatage de la photo (sert de paramètre `?v=` pour contourner le cache), ou None."""
    ligne = db.query(AvatarORM.updated_at).filter(AvatarORM.user_id == user_id).one_or_none()
    return ligne[0].isoformat() if ligne else None
