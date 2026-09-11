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
    """Récupère une épreuve par id ou lève 404 (voie ADMIN : brouillons
    compris)."""
    e = db.query(EpreuveORM).filter(EpreuveORM.id == epreuve_id).one_or_none()
    if not e:
        raise HTTPException(404, "Épreuve introuvable")
    return e


def get_public_epreuve_or_404(db: Session, epreuve_id: str, user=None) -> EpreuveORM:
    """Récupère une épreuve PUBLIÉE ou lève 404 (une épreuve brouillon ou
    retirée n'existe pas publiquement). Si `user` est fourni et que
    l'épreuve est payante, vérifie aussi `has_access` — 403 si un
    abonnement est requis (utilisé par les routes qui créent des données
    liées à une épreuve : conversations, notes, signalements)."""
    from ..core import store

    e = get_epreuve_or_404(db, epreuve_id)
    if e.statut != "publie":
        raise HTTPException(404, "Épreuve introuvable")
    if user is not None and not store.is_gratuit(e) and not store.has_access(db, user.id, e):
        raise HTTPException(403, "Accès non autorisé — un abonnement est requis")
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
