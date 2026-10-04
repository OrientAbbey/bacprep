"""Calendrier officiel des examens et résultats : lecture publique, CRUD admin.

Aucune date n'est codée en dur : l'admin saisit les dates officielles."""
from __future__ import annotations

import re
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from ..db import get_db
from ..db_models import EvenementORM
from .deps import log_admin_event, require_admin

public = APIRouter(prefix="/api/calendrier", tags=["calendrier"])
admin = APIRouter(prefix="/api/admin/evenements", tags=["admin"])

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _date_valide(v: str) -> str:
    if v and not _DATE.match(v):
        raise ValueError("date attendue au format AAAA-MM-JJ")
    return v


class EvenementIn(BaseModel):
    titre: str = Field(min_length=1, max_length=160)
    type: Literal["examen", "resultats", "inscription"] = "examen"
    evaluation: str = Field(default="", max_length=60)  # vide = tous les examens
    date_debut: str
    date_fin: str = ""
    lien_officiel: str = Field(default="", max_length=300)
    visible: bool = True

    _d1 = field_validator("date_debut")(_date_valide)
    _d2 = field_validator("date_fin")(_date_valide)

    @field_validator("lien_officiel")
    @classmethod
    def _lien_http(cls, v: str) -> str:
        if v and not v.startswith(("https://", "http://")):
            raise ValueError("le lien doit commencer par http(s)://")
        return v


class EvenementUpdate(BaseModel):
    titre: Optional[str] = Field(default=None, min_length=1, max_length=160)
    type: Optional[Literal["examen", "resultats", "inscription"]] = None
    evaluation: Optional[str] = Field(default=None, max_length=60)
    date_debut: Optional[str] = None
    date_fin: Optional[str] = None
    lien_officiel: Optional[str] = Field(default=None, max_length=300)
    visible: Optional[bool] = None

    _d1 = field_validator("date_debut", "date_fin")(lambda v: _date_valide(v) if v is not None else v)

    @field_validator("lien_officiel")
    @classmethod
    def _lien_http(cls, v: Optional[str]) -> Optional[str]:
        if v and not v.startswith(("https://", "http://")):
            raise ValueError("le lien doit commencer par http(s)://")
        return v


def _out(e: EvenementORM) -> dict:
    return {c.name: getattr(e, c.name) for c in EvenementORM.__table__.columns}


@public.get("")
def lister_public(db: Session = Depends(get_db)) -> list[dict]:
    rows = db.query(EvenementORM).filter(EvenementORM.visible.is_(True)).order_by(EvenementORM.date_debut).all()
    return [_out(e) for e in rows]


@admin.get("")
def lister_admin(db: Session = Depends(get_db), lock=Depends(require_admin)) -> list[dict]:
    return [_out(e) for e in db.query(EvenementORM).order_by(EvenementORM.date_debut).all()]


@admin.post("")
def creer(payload: EvenementIn, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    e = EvenementORM(**payload.model_dump())
    db.add(e)
    log_admin_event(db, None, "evenement_cree", lock.email, {"titre": e.titre, "date": e.date_debut})
    db.commit()
    return _out(e)


@admin.patch("/{evenement_id}")
def modifier(evenement_id: str, payload: EvenementUpdate, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    e = db.get(EvenementORM, evenement_id)
    if not e:
        raise HTTPException(404, "Événement introuvable")
    changes = payload.model_dump(exclude_unset=True)
    for k, v in changes.items():
        setattr(e, k, v)
    log_admin_event(db, None, "evenement_modifie", lock.email, {"id": e.id, **changes})
    db.commit()
    return _out(e)


@admin.delete("/{evenement_id}")
def supprimer(evenement_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    e = db.get(EvenementORM, evenement_id)
    if not e:
        raise HTTPException(404, "Événement introuvable")
    log_admin_event(db, None, "evenement_supprime", lock.email, {"id": e.id, "titre": e.titre})
    db.delete(e)
    db.commit()
    return {"ok": True}
