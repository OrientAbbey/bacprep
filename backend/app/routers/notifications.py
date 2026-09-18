"""Cloche des notifications côté élève.

Une notification administrateur, une fois ACTIVE, est visible par tous les
utilisateurs ; sa lecture est suivie par utilisateur (`NotificationReadORM`,
alimenté par « marquer comme lue »). Le GET renvoie le nombre de NON LUES pour
le badge du menu + la liste (récentes d'abord), enrichie du lien éventuel vers
l'épreuve.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..db_models import NotificationORM, NotificationReadORM
from .auth import require_user

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


def _notification_out(n: NotificationORM, lue: bool) -> dict:
    return {
        "id": n.id,
        "titre": n.titre,
        "message": n.message,
        "type": n.type,
        "epreuve_id": n.epreuve_id,
        "lue": lue,
        "created_at": n.created_at,
        "updated_at": n.updated_at,
    }


@router.get("")
def list_notifications(db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """Notifications ACTIVES pour la cloche de l'utilisateur connecté (la
    cloche est une fonctionnalité du menu compte), avec l'état « lu » et le
    nombre de non lues pour le badge."""
    actives = (
        db.query(NotificationORM)
        .filter(NotificationORM.actif == True)  # noqa: E712
        .order_by(NotificationORM.created_at.desc())
        .limit(50)
        .all()
    )
    if not actives:
        return {"non_lues": 0, "items": []}
    lues = {
        r.notification_id
        for r in db.query(NotificationReadORM)
        .filter(NotificationReadORM.user_id == user.id).all()
    }
    non_lues = sum(1 for n in actives if n.id not in lues)
    return {
        "non_lues": non_lues,
        "items": [_notification_out(n, n.id in lues) for n in actives],
    }


@router.post("/{notification_id}/lue")
def marquer_lue(notification_id: str, db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """Marque une notification comme lue pour cet utilisateur (idempotent :
    un second passage ne crée pas de doublon)."""
    n = db.query(NotificationORM).filter(NotificationORM.id == notification_id).one_or_none()
    if not n or not n.actif:
        raise HTTPException(404, "Notification introuvable")
    existe = (
        db.query(NotificationReadORM)
        .filter(
            NotificationReadORM.notification_id == notification_id,
            NotificationReadORM.user_id == user.id,
        )
        .one_or_none()
    )
    if not existe:
        db.add(NotificationReadORM(notification_id=notification_id, user_id=user.id))
        db.commit()
    return {"ok": True}


@router.post("/lues")
def tout_marquer_lue(db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """« Tout marquer comme lu » : pose un marqueur pour CHAQUE notification
    active non encore lue de l'utilisateur (une seule requête d'insertion)."""
    actives = (
        db.query(NotificationORM)
        .filter(NotificationORM.actif == True)  # noqa: E712
        .all()
    )
    if not actives:
        return {"ok": True}
    deja = {
        r.notification_id
        for r in db.query(NotificationReadORM)
        .filter(NotificationReadORM.user_id == user.id).all()
    }
    for n in actives:
        if n.id not in deja:
            db.add(NotificationReadORM(notification_id=n.id, user_id=user.id))
    db.commit()
    return {"ok": True}