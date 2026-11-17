"""Onglet « Paramètres » du back-office : gestion des listes énumératives
du référentiel (table ``referentiel_options``). L'admin peut consulter,
ajouter, renommer et supprimer des options par scope (niveau, classe,
évaluation, matière, série). Les formulaires d'épreuve consomment
les mêmes données et peuvent auto-ajouter une valeur hors liste
(`ensure_option` dans core/referentiel_options).
"""
from __future__ import annotations

import json
from collections import Counter
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core import referentiel_options as ref_store
from ..db import get_db
from ..db_models import (
    BanqueClasseMetaORM,
    BanqueExerciceORM,
    BanquePartieORM,
    EpreuveFiliereORM,
    EpreuveORM,
    ReferentielOptionORM,
)
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


def _json_codes(raw: str | None) -> list[str]:
    try:
        values = json.loads(raw or "[]")
    except (TypeError, json.JSONDecodeError):
        return []
    return [value for value in values if isinstance(value, str)] if isinstance(values, list) else []


def _banque_references(db: Session, scope: str) -> dict[str, int]:
    """Compte les références de la banque stockées en JSON ou sans clé
    étrangère. Les lignes distinctes sont les entités impactées, pas les
    occurrences répétées d'un même code dans une liste."""
    counts: Counter[str] = Counter()

    if scope == "matiere":
        for (code,) in db.query(BanquePartieORM.matiere).all():
            if code:
                counts[code] += 1
    elif scope == "classe":
        for (code,) in db.query(BanqueClasseMetaORM.classe).all():
            if code:
                counts[code] += 1

    exercise_column = {
        "matiere": BanqueExerciceORM.matieres_json,
        "classe": BanqueExerciceORM.classes_json,
        "serie": BanqueExerciceORM.series_json,
    }.get(scope)
    if exercise_column is not None:
        for (raw,) in db.query(exercise_column).all():
            counts.update(set(_json_codes(raw)))
    return dict(counts)


def _usage_counts(db: Session) -> dict[str, dict[str, int]]:
    """Nombre d'épreuves utilisant chaque option, par scope, banque comprise.
    Les séries d'épreuves historiques sont comptées séparément des codes JSON
    des exercices de banque."""
    cols = ref_store.SCOPE_EPREUVE_COLONNE
    counts: dict[str, dict[str, int]] = {scope: {} for scope in ref_store.SCOPES}
    for scope, column in cols.items():
        for code, n in (
            db.query(getattr(EpreuveORM, column), func.count(EpreuveORM.id))
            .group_by(getattr(EpreuveORM, column))
            .all()
        ):
            if code:  # colonnes non nulles
                counts[scope][(code or "").strip()] = n
    for code, n in (
        db.query(EpreuveFiliereORM.filiere, func.count(EpreuveFiliereORM.id))
        .group_by(EpreuveFiliereORM.filiere)
        .all()
    ):
        if code:
            counts["serie"][code] = n
    for scope in ("matiere", "classe", "serie"):
        for code, n in _banque_references(db, scope).items():
            counts[scope][code] = counts[scope].get(code, 0) + n
    return counts


def _en_usage(db: Session, scope: str, code: str) -> int:
    """Nombre d'entités utilisant cette option, dans les épreuves historiques
    et dans la banque ; sert de garde-fou au renommage/suppression."""
    key = (code or "").strip()
    column = ref_store.SCOPE_EPREUVE_COLONNE.get(scope)
    historic = 0
    if column is not None:
        historic = int(
            db.query(func.count(EpreuveORM.id)).filter(getattr(EpreuveORM, column) == key).scalar() or 0
        )
    if scope == "serie":
        historic += int(
            db.query(func.count(EpreuveFiliereORM.id)).filter(EpreuveFiliereORM.filiere == key).scalar() or 0
        )
    return historic + _banque_references(db, scope).get(key, 0)


@router.get("/referentiel-options")
def admin_list_referentiel_options(
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Options regroupées par scope, ordonnées par `position` (puis code),
    avec le nombre d'épreuves utilisant chaque valeur (`en_usage`). Les
    scopes retirés du référentiel (ex. « session ») sont exclus, même si
    d'anciennes lignes traînent en base (revue 2026-09-18)."""
    rows = (
        db.query(ReferentielOptionORM)
        .filter(ReferentielOptionORM.scope.in_(ref_store.SCOPES))
        .order_by(ReferentielOptionORM.position, ReferentielOptionORM.code)
        .all()
    )
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
        if code != row.code:
            if _en_usage(db, row.scope, row.code):
                # Le code est une référence d'intégrité pour les épreuves
                # historiques comme pour la banque ; seul le libellé se modifie.
                raise HTTPException(
                    409,
                    "Cette valeur est utilisée par des épreuves ou la banque d'exercices — "
                    "modifiez le libellé (label) plutôt que le code.",
                )
            if ref_store.get_option(db, row.scope, code) is not None:
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
    """Supprime une option uniquement si aucune référence de la banque ne
    dépend de son code. Les épreuves historiques peuvent conserver une valeur
    hors liste, conformément au comportement existant."""
    row = db.query(ReferentielOptionORM).filter(ReferentielOptionORM.id == option_id).one_or_none()
    if not row:
        raise HTTPException(404, "Option introuvable")
    banque_usage = _banque_references(db, row.scope).get(row.code, 0)
    if banque_usage:
        raise HTTPException(
            409,
            f"Cette valeur est utilisée par {banque_usage} élément(s) de la banque d'exercices — "
            "réaffectez-les avant de supprimer l'option.",
        )
    db.delete(row)
    db.commit()
    log_admin_event(
        db, None, "referentiel_option_supprimee", email=lock.email,
        details={"scope": row.scope, "code": row.code},
    )
    return {"ok": True}