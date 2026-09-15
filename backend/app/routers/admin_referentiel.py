"""Onglet « Paramètres » du back-office : gestion des listes énumératives
du référentiel (table ``referentiel_options``). L'admin peut consulter,
ajouter, renommer et supprimer des options par scope (niveau, classe,
évaluation, matière, session, série). Les formulaires d'épreuve consomment
les mêmes données et peuvent auto-ajouter une valeur hors liste
(`ensure_option` dans core/referentiel_options).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core import referentiel_options as ref_store
from ..db import get_db
from ..db_models import EpreuveFiliereORM, EpreuveORM, ReferentielOptionORM
from .deps import log_admin_event, require_admin

router = APIRouter(prefix="/api/admin", tags=["admin"])


class ReferentielOptionIn(BaseModel):
    scope: str = Field(min_length=1, max_length=30)
    code: str = Field(min_length=1, max_length=120)
    label: Optional[str] = Field(default=None, max_length=120)
    position: Optional[int] = None


class ReferentielOptionUpdate(BaseModel):
    code: Optional[str] = Field(default=None, min_length=1, max_length=120)
    label: Optional[str] = Field(default=None, max_length=120)
    position: Optional[int] = None


def _check_scope(scope: str) -> None:
    if scope not in ref_store.SCOPES:
        raise HTTPException(422, f"scope inconnu — attendu parmi {', '.join(ref_store.SCOPES)}")


def _usage_counts(db: Session) -> dict[str, dict[str, int]]:
    """Nombre d'épreuves utilisant chaque option, par scope. Obtenu en deux
    requêtes (colonnes d'épreuves + jointure séries) plutôt qu'une requête
    par option."""
    cols = ref_store.SCOPE_EPREUVE_COLONNE
    counts: dict[str, dict[str, int]] = {scope: {} for scope in ref_store.SCOPES}
    for scope, column in cols.items():
        for code, n in (
            db.query(getattr(EpreuveORM, column), func.count(EpreuveORM.id))
            .group_by(getattr(EpreuveORM, column))
            .all()
        ):
            if code:  # colonnes non nulles hormis session
                counts[scope][(code or "").strip()] = n
    for code, n in (
        db.query(EpreuveFiliereORM.filiere, func.count(EpreuveFiliereORM.id))
        .group_by(EpreuveFiliereORM.filiere)
        .all()
    ):
        if code:
            counts["serie"][code] = n
    return counts


@router.get("/referentiel-options")
def admin_list_referentiel_options(
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Options regroupées par scope, ordonnées par `position` (puis code),
    avec le nombre d'épreuves utilisant chaque valeur (`en_usage`)."""
    rows = db.query(ReferentielOptionORM).order_by(ReferentielOptionORM.position, ReferentielOptionORM.code).all()
    usage = _usage_counts(db)
    grouped: dict[str, list[dict]] = {scope: [] for scope in ref_store.SCOPES}
    for row in rows:
        grouped.setdefault(row.scope, []).append(
            {
                "id": row.id,
                "scope": row.scope,
                "code": row.code,
                "label": row.label or row.code,
                "position": row.position,
                "en_usage": usage.get(row.scope, {}).get(row.code, 0),
            }
        )
    return grouped


@router.post("/referentiel-options")
def admin_create_referentiel_option(
    payload: ReferentielOptionIn,
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Ajoute une option. Valeur normalisée (trim) ; refus si l'option
    (scope, code) existe déjà."""
    _check_scope(payload.scope)
    code = payload.code.strip()
    if not code:
        raise HTTPException(422, "code vide")
    if ref_store.get_option(db, payload.scope, code) is not None:
        raise HTTPException(409, "Cette option existe déjà pour ce scope")
    position = payload.position
    if position is None:
        position = db.query(ReferentielOptionORM).filter(ReferentielOptionORM.scope == payload.scope).count()
    row = ReferentielOptionORM(
        scope=payload.scope,
        code=code,
        label=payload.label.strip() if payload.label else None,
        position=position,
    )
    db.add(row)
    db.commit()
    log_admin_event(
        db, None, "referentiel_option_ajoutee", email=lock.email,
        details={"scope": row.scope, "code": row.code},
    )
    return {"id": row.id, "scope": row.scope, "code": row.code, "label": row.label or row.code}


@router.patch("/referentiel-options/{option_id}")
def admin_update_referentiel_option(
    option_id: str,
    payload: ReferentielOptionUpdate,
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Renomme/re-labellise une option (unique (scope, code) conservé)."""
    row = db.query(ReferentielOptionORM).filter(ReferentielOptionORM.id == option_id).one_or_none()
    if not row:
        raise HTTPException(404, "Option introuvable")
    if payload.code is not None:
        code = payload.code.strip()
        if not code:
            raise HTTPException(422, "code vide")
        if code != row.code and ref_store.get_option(db, row.scope, code) is not None:
            raise HTTPException(409, "Cette valeur existe déjà pour ce scope")
        row.code = code
    if payload.label is not None:
        row.label = payload.label.strip() or None
    if payload.position is not None:
        row.position = payload.position
    db.add(row)
    db.commit()
    log_admin_event(
        db, None, "referentiel_option_renommee", email=lock.email,
        details={"scope": row.scope, "code": row.code},
    )
    return {"id": row.id, "scope": row.scope, "code": row.code, "label": row.label or row.code}


@router.delete("/referentiel-options/{option_id}")
def admin_delete_referentiel_option(
    option_id: str,
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Supprime une option de la liste. Les épreuves déjà saisies avec cette
    valeur GARDENT leur valeur (aucune réécriture) — l'appelant affiche le
    compteur `en_usage` pour confirmation avant suppression."""
    row = db.query(ReferentielOptionORM).filter(ReferentielOptionORM.id == option_id).one_or_none()
    if not row:
        raise HTTPException(404, "Option introuvable")
    db.delete(row)
    db.commit()
    log_admin_event(
        db, None, "referentiel_option_supprimee", email=lock.email,
        details={"scope": row.scope, "code": row.code},
    )
    return {"ok": True}