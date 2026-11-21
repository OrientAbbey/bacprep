"""Calendrier officiel des examens et résultats : lecture publique, CRUD admin.

Aucune date n'est codée en dur : l'admin saisit les dates officielles."""
from __future__ import annotations

import re
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from ..db import get_db
from ..db_models import EvenementORM, to_dict
from .deps import log_admin_event, require_admin

public = APIRouter(prefix="/api/calendrier", tags=["calendrier"])
admin = APIRouter(prefix="/api/admin/evenements", tags=["admin"])

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _date_valide(valeur: str) -> str:
    if valeur and not _DATE.match(valeur):
        raise ValueError("date attendue au format AAAA-MM-JJ")
    return valeur


def _lien_http(valeur: Optional[str]) -> Optional[str]:
    """N'accepte qu'un lien http(s), vide autorisé (champ optionnel)."""
    if valeur and not valeur.startswith(("https://", "http://")):
        raise ValueError("le lien doit commencer par http(s)://")
    return valeur


class EvenementIn(BaseModel):
    """Création d'un événement : titre, type, évaluation ciblée, dates, lien officiel et visibilité publique."""
    titre: str = Field(min_length=1, max_length=160)
    type: Literal["examen", "resultats", "inscription"] = "examen"
    evaluation: str = Field(default="", max_length=60)  # vide = tous les examens
    date_debut: str
    date_fin: str = ""
    lien_officiel: str = Field(default="", max_length=300)
    visible: bool = True

    _d1 = field_validator("date_debut")(_date_valide)
    _d2 = field_validator("date_fin")(_date_valide)

    _l1 = field_validator("lien_officiel")(_lien_http)


class EvenementUpdate(BaseModel):
    """Modification partielle d'un événement du calendrier ; seuls les champs présents sont appliqués."""
    titre: Optional[str] = Field(default=None, min_length=1, max_length=160)
    type: Optional[Literal["examen", "resultats", "inscription"]] = None
    evaluation: Optional[str] = Field(default=None, max_length=60)
    date_debut: Optional[str] = None
    date_fin: Optional[str] = None
    lien_officiel: Optional[str] = Field(default=None, max_length=300)
    visible: Optional[bool] = None

    _d1 = field_validator("date_debut", "date_fin")(lambda v: _date_valide(v) if v is not None else v)

    _l1 = field_validator("lien_officiel")(_lien_http)


@public.get("")
def lister_public(db: Session = Depends(get_db)) -> list[dict]:
    """Renvoie les événements visibles, ordonnés par date de début, pour la page publique."""
    rows = db.query(EvenementORM).filter(EvenementORM.visible.is_(True)).order_by(EvenementORM.date_debut).all()
    return [to_dict(e) for e in rows]


@admin.get("")
def lister_admin(db: Session = Depends(get_db), lock=Depends(require_admin)) -> list[dict]:
    """Renvoie tous les événements, y compris masqués, pour le back-office."""
    return [to_dict(e) for e in db.query(EvenementORM).order_by(EvenementORM.date_debut).all()]


@admin.post("")
def creer(payload: EvenementIn, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    """Crée un événement et inscrit l'action dans le journal d'administration."""
    e = EvenementORM(**payload.model_dump())
    db.add(e)
    log_admin_event(db, None, "evenement_cree", lock.email, {"titre": e.titre, "date": e.date_debut})
    db.commit()
    return to_dict(e)


@admin.patch("/{evenement_id}")
def modifier(evenement_id: str, payload: EvenementUpdate, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    """Applique les champs fournis à un événement existant et journalise les modifications."""
    e = db.get(EvenementORM, evenement_id)
    if not e:
        raise HTTPException(404, "Événement introuvable")
    changes = payload.model_dump(exclude_unset=True)
    for k, v in changes.items():
        setattr(e, k, v)
    log_admin_event(db, None, "evenement_modifie", lock.email, {"id": e.id, **changes})
    db.commit()
    return to_dict(e)


@admin.delete("/{evenement_id}")
def supprimer(evenement_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    """Supprime un événement après l'avoir tracé dans le journal admin."""
    e = db.get(EvenementORM, evenement_id)
    if not e:
        raise HTTPException(404, "Événement introuvable")
    log_admin_event(db, None, "evenement_supprime", lock.email, {"id": e.id, "titre": e.titre})
    db.delete(e)
    db.commit()
    return {"ok": True}
