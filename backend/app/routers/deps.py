"""Dépendances et helpers partagés entre les routers (anciennement dans un
admin.py monolithique) : authentification admin, lookup d'épreuve et journal
d'audit.
"""
from __future__ import annotations

import json

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from ..core import admin_session
from ..core.logging_config import get_logger
from ..db import get_db
from ..db_models import AdminEventORM, EpreuveORM

log = get_logger("admin")


def get_epreuve_or_404(db: Session, epreuve_id: str) -> EpreuveORM:
    """Récupère une épreuve par id ou lève 404."""
    e = db.query(EpreuveORM).filter(EpreuveORM.id == epreuve_id).one_or_none()
    if not e:
        raise HTTPException(404, "Épreuve introuvable")
    return e


def require_admin(x_admin_session: str = Header(default=""), db: Session = Depends(get_db)):
    """Dépendance FastAPI protégeant toutes les routes admin : valide
    l'en-tête X-Admin-Session contre le verrou persisté en base et
    rafraîchit son horodatage d'activité (glissement des 30 min)."""
    lock = admin_session.touch(db, x_admin_session)
    if not lock:
        raise HTTPException(401, "Session admin invalide ou expirée")
    return lock


def log_admin_event(
    db: Session,
    epreuve_id: str | None,
    action: str,
    email: str = "",
    details: dict | None = None,
) -> None:
    """Trace une action admin dans `admin_events` (audit) — avec l'email de
    son auteur et un détail libre sérialisé en JSON."""
    db.add(
        AdminEventORM(
            epreuve_id=epreuve_id,
            action=action,
            email=email or "",
            details=json.dumps(details or {}, ensure_ascii=False),
        )
    )
    db.commit()
