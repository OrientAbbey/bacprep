"""Onglet « Formules » du back-office : CRUD des formules d'abonnement."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core.plans import plan_out
from ..core.subscriptions import SCOPE_LABELS
from ..db import get_db
from ..db_models import PlanORM
from .deps import log_admin_event, require_admin

router = APIRouter(prefix="/api/admin/plans", tags=["admin"])


class PlanIn(BaseModel):
    scope: str
    libelle: str = Field(min_length=1, max_length=80)
    libelle_en: str = Field(default="", max_length=80)
    description: str = Field(default="", max_length=300)
    description_en: str = Field(default="", max_length=300)
    prix: int = Field(ge=100, le=1_000_000)  # FCFA
    duree_jours: int = Field(ge=1, le=3650)
    actif: bool = True
    ordre: int = 0


class PlanUpdate(BaseModel):
    libelle: Optional[str] = Field(default=None, min_length=1, max_length=80)
    libelle_en: Optional[str] = Field(default=None, max_length=80)
    description: Optional[str] = Field(default=None, max_length=300)
    description_en: Optional[str] = Field(default=None, max_length=300)
    prix: Optional[int] = Field(default=None, ge=100, le=1_000_000)
    duree_jours: Optional[int] = Field(default=None, ge=1, le=3650)
    actif: Optional[bool] = None
    ordre: Optional[int] = None


def _get(db: Session, plan_id: str) -> PlanORM:
    p = db.get(PlanORM, plan_id)
    if not p:
        raise HTTPException(404, "Formule introuvable")
    return p


@router.get("")
def lister(db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    plans = db.query(PlanORM).order_by(PlanORM.ordre, PlanORM.prix).all()
    return {"plans": [plan_out(p) for p in plans], "scopes": SCOPE_LABELS}


@router.post("")
def creer(payload: PlanIn, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    if payload.scope not in SCOPE_LABELS:
        raise HTTPException(422, f"scope inconnu — attendu parmi {', '.join(SCOPE_LABELS)}")
    data = payload.model_dump()
    if not data["ordre"]:  # 0 = non précisé : la nouvelle formule se place EN DERNIER
        data["ordre"] = (db.query(func.max(PlanORM.ordre)).scalar() or 0) + 1
    p = PlanORM(**data)
    db.add(p)
    log_admin_event(db, None, "plan_cree", lock.email, {"scope": p.scope, "prix": p.prix})
    db.commit()
    return plan_out(p)


@router.patch("/{plan_id}")
def modifier(plan_id: str, payload: PlanUpdate, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    p = _get(db, plan_id)
    changes = payload.model_dump(exclude_unset=True)
    for k, v in changes.items():
        setattr(p, k, v)
    log_admin_event(db, None, "plan_modifie", lock.email, {"id": p.id, **changes})
    db.commit()
    return plan_out(p)


@router.delete("/{plan_id}")
def supprimer(plan_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    p = _get(db, plan_id)
    log_admin_event(db, None, "plan_supprime", lock.email, {"id": p.id, "scope": p.scope})
    db.delete(p)
    db.commit()
    return {"ok": True}
