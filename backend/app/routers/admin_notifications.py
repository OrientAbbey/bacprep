"""Back-office — gestion des notifications diffusées à tous les utilisateurs.

CRUD complet (création, modification, activation/désactivation, suppression)
sur la table `notifications`, tracé au journal d'audit. L'activation est
pilote par le champ `actif` (une notification inactive reste stockée mais
disparaît des cloches).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..db_models import NotificationORM
from ..models import NotificationIn, NotificationUpdate
from .deps import log_admin_event, require_admin

router = APIRouter(prefix="/api/admin/notifications", tags=["admin", "notifications"])


def _notification_out(n: NotificationORM) -> dict:
    """Projette une notification vers la forme API (l'admin voit toutes les
    notifications, actives ou non)."""
    return {
        "id": n.id,
        "titre": n.titre,
        "message": n.message,
        "type": n.type,
        "epreuve_id": n.epreuve_id,
        "actif": n.actif,
        "created_at": n.created_at,
        "updated_at": n.updated_at,
    }


@router.get("")
def admin_list_notifications(
    db: Session = Depends(get_db), lock=Depends(require_admin)
) -> list[dict]:
    """Liste TOUTES les notifications (actives et désactivées), les plus
    récentes en premier."""
    return [
        _notification_out(n)
        for n in db.query(NotificationORM).order_by(NotificationORM.created_at.desc()).all()
    ]


@router.post("")
def admin_create_notification(
    payload: NotificationIn, db: Session = Depends(get_db), lock=Depends(require_admin)
) -> dict:
    """Crée une notification. `epreuve_id` optionnel : si fourni et que
    l'épreuve n'existe pas, la notification est créée SANS lien (la cloche
    gère les liens morts en silence — l'enregistrement ne doit pas échouer
    pour une épreuve supprimée entre-temps)."""
    n = NotificationORM(
        titre=payload.titre.strip(),
        message=payload.message.strip(),
        type=payload.type.strip() or "information",
        epreuve_id=payload.epreuve_id or None,
        actif=payload.actif,
    )
    db.add(n)
    db.commit()
    log_admin_event(
        db, n.epreuve_id, "notification_created", email=lock.email,
        details={"notification_id": n.id, "titre": n.titre, "actif": n.actif},
    )
    return _notification_out(n)


@router.put("/{notification_id}")
def admin_update_notification(
    notification_id: str,
    payload: NotificationUpdate,
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Modifie une notification (partielle, `exclude_unset=True`) —
    `actif` bascule la visibilité dans les cloches (activation/
    désactivation)."""
    n = db.query(NotificationORM).filter(NotificationORM.id == notification_id).one_or_none()
    if not n:
        raise HTTPException(404, "Notification introuvable")
    data = payload.model_dump(exclude_unset=True)
    if "titre" in data:
        n.titre = (data["titre"] or "").strip()
    if "message" in data:
        n.message = (data["message"] or "").strip()
    if "type" in data:
        n.type = (data["type"] or "information").strip()
    if "epreuve_id" in data:
        n.epreuve_id = data["epreuve_id"] or None
    if "actif" in data:
        n.actif = data["actif"]
    db.add(n)
    db.commit()
    log_admin_event(
        db, n.epreuve_id, "notification_updated", email=lock.email,
        details={"notification_id": n.id, "titre": n.titre, "actif": n.actif},
    )
    return _notification_out(n)


@router.post("/{notification_id}/toggle")
def admin_toggle_notification(
    notification_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)
) -> dict:
    """Raccourci d'activation/désactivation (le back-office n'a pas à
    renvoyer tout le payload pour un simple interrupteur)."""
    n = db.query(NotificationORM).filter(NotificationORM.id == notification_id).one_or_none()
    if not n:
        raise HTTPException(404, "Notification introuvable")
    n.actif = not n.actif
    db.add(n)
    db.commit()
    log_admin_event(
        db, n.epreuve_id, "notification_toggled", email=lock.email,
        details={"notification_id": n.id, "actif": n.actif},
    )
    return _notification_out(n)


@router.delete("/{notification_id}")
def admin_delete_notification(
    notification_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)
) -> dict:
    """Supprime définitivement une notification (les marqueurs de lecture
    liés sont purgés avec elle via l'ON DELETE CASCADE de la FK)."""
    n = db.query(NotificationORM).filter(NotificationORM.id == notification_id).one_or_none()
    if not n:
        raise HTTPException(404, "Notification introuvable")
    db.delete(n)
    db.commit()
    log_admin_event(
        db, n.epreuve_id, "notification_deleted", email=lock.email,
        details={"notification_id": n.id, "titre": n.titre},
    )
    return {"ok": True}