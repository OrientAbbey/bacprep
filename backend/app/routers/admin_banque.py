"""Administration de la banque d'exercices du générateur V4.10.

Les matières, classes et spécialités restent dans le référentiel partagé ; ce
routeur ne possède que les parties, les exercices et les métadonnées de classe.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core import referentiel, referentiel_options as ref_store
from ..core.banque_generation import DIFFICULTES, SPECIAL_AUCUNE
from ..db import get_db, utc_now
from ..db_models import (
    BanqueClasseMetaORM,
    BanqueExerciceORM,
    BanqueGenerationORM,
    BanqueJournalORM,
    BanquePartieORM,
    ReferentielOptionORM,
)
from .deps import log_admin_event, require_admin

router = APIRouter(prefix="/api/admin/banque", tags=["admin-banque"])

SESSIONS_CONNNUES = sum(1 for v in referentiel.EVALUATIONS if v.startswith("SEQUENCE "))
ID_32 = re.compile(r"^[0-9a-f]{32}$")


def _uuid_hex(value: str | None, *, optional: bool = False) -> str:
    if value is None and optional:
        return uuid.uuid4().hex
    try:
        return uuid.UUID(str(value)).hex
    except (ValueError, AttributeError, TypeError) as exc:
        raise HTTPException(422, "Identifiant UUID invalide") from exc


def _json_list(value: str) -> list[str]:
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return []
    return parsed if isinstance(parsed, list) else []


def _partie(db: Session, partie_id: str) -> BanquePartieORM:
    row = db.get(BanquePartieORM, _uuid_hex(partie_id))
    if row is None:
        raise HTTPException(404, "Partie introuvable")
    return row


def _exercice_out(row: BanqueExerciceORM) -> dict[str, Any]:
    return {
        "id": row.id,
        "sujet": row.sujet,
        "corrige": row.corrige,
        "partie_id": row.partie_id,
        "session": row.session,
        "niveau_intrinseque": row.niveau_intrinseque,
        "tag_examen": row.tag_examen,
        "actif": row.actif,
        "matieres": _json_list(row.matieres_json),
        "classes": _json_list(row.classes_json),
        "series": _json_list(row.series_json),
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def _partie_out(row: BanquePartieORM) -> dict[str, Any]:
    return {"id": row.id, "matiere": row.matiere, "nom": row.nom, "ordre": row.ordre}


def _codes_referentiel(db: Session, scope: str) -> set[str]:
    return {
        code
        for (code,) in db.query(ReferentielOptionORM.code)
        .filter(ReferentielOptionORM.scope == scope)
        .all()
    }


def _validate_exercise(db: Session, data: dict[str, Any]) -> dict[str, Any]:
    part_id = _uuid_hex(data.get("partie_id"))
    part = db.get(BanquePartieORM, part_id)
    if part is None:
        raise HTTPException(422, "La partie sélectionnée est inconnue")
    matieres = list(dict.fromkeys(data.get("matieres", [])))
    classes = list(dict.fromkeys(data.get("classes", [])))
    series = list(dict.fromkeys(data.get("series", [])))
    if not matieres or not classes:
        raise HTTPException(422, "Au moins une matière et une classe sont obligatoires")
    if part.matiere not in _codes_referentiel(db, "matiere"):
        raise HTTPException(422, "Matière de partie inconnue du référentiel")
    if not set(matieres) <= _codes_referentiel(db, "matiere"):
        raise HTTPException(422, "Une matière est inconnue du référentiel")
    if not set(classes) <= _codes_referentiel(db, "classe"):
        raise HTTPException(422, "Une classe est inconnue du référentiel")
    known_series = _codes_referentiel(db, "serie")
    if not (set(series) - {SPECIAL_AUCUNE}) <= known_series:
        raise HTTPException(422, "Une spécialité est inconnue du référentiel")
    if data.get("session") is not None and not 1 <= data["session"] <= SESSIONS_CONNNUES:
        raise HTTPException(422, "La session est hors des séquences du référentiel")
    if part.matiere not in matieres:
        raise HTTPException(422, "La matière de la partie doit être présente dans l'exercice")
    if data.get("session") is None and data.get("tag_examen"):
        raise HTTPException(422, "Le tag Examen est interdit pour une session vide")
    data.update(partie_id=part_id, matieres=matieres, classes=classes, series=series)
    return data


class PartieIn(BaseModel):
    matiere: str = Field(min_length=1, max_length=120)
    nom: str = Field(min_length=1, max_length=160)
    ordre: int = Field(default=0, ge=0, le=10000)

    @field_validator("matiere", "nom")
    @classmethod
    def trim_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("valeur vide")
        return value


class ExerciceIn(BaseModel):
    id: str | None = None
    sujet: str = Field(min_length=1, max_length=100_000)
    corrige: str = Field(min_length=1, max_length=100_000)
    partie_id: str
    session: int | None = Field(default=None, ge=1, le=6)
    niveau_intrinseque: str = "Moyen"
    tag_examen: bool = False
    actif: bool = True
    matieres: list[str] = Field(min_length=1, max_length=20)
    classes: list[str] = Field(min_length=1, max_length=20)
    series: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("sujet", "corrige")
    @classmethod
    def trim_body(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("contenu vide")
        return value

    @field_validator("niveau_intrinseque")
    @classmethod
    def known_level(cls, value: str) -> str:
        if value not in DIFFICULTES:
            raise ValueError("niveau intrinsèque inconnu")
        return value

    @field_validator("matieres", "classes", "series")
    @classmethod
    def clean_codes(cls, values: list[str]) -> list[str]:
        out = [v.strip() for v in values]
        if any(not v for v in out):
            raise ValueError("code vide")
        if len(set(out)) != len(out):
            raise ValueError("valeurs dupliquées")
        return out

    @model_validator(mode="after")
    def validate_exam_tag(self):
        if self.session is None and self.tag_examen:
            raise ValueError("tagExamen doit être faux si session est vide")
        return self


class ClasseMetaIn(BaseModel):
    a_examen: bool = False
    specialite_obligatoire: bool = False


class ImportIn(BaseModel):
    mode: str = Field(pattern="^(remplacer|fusionner)$")
    snapshot: dict[str, Any]

    @field_validator("snapshot")
    @classmethod
    def limit_snapshot_bytes(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 25_000_000:
            raise ValueError("snapshot trop volumineux")
        return value


@router.get("")
def lister(
    matiere: str | None = Query(default=None, max_length=120),
    classe: str | None = Query(default=None, max_length=80),
    partie_id: str | None = Query(default=None, max_length=40),
    session: int | None = Query(default=None, ge=1, le=SESSIONS_CONNNUES),
    recherche: str | None = Query(default=None, max_length=200),
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    parties_q = db.query(BanquePartieORM)
    if matiere:
        parties_q = parties_q.filter(BanquePartieORM.matiere == matiere)
    parties = parties_q.order_by(BanquePartieORM.matiere, BanquePartieORM.ordre, BanquePartieORM.nom).all()
    exercices_q = db.query(BanqueExerciceORM)
    if partie_id:
        exercices_q = exercices_q.filter(BanqueExerciceORM.partie_id == _uuid_hex(partie_id))
    if session is not None:
        exercices_q = exercices_q.filter(BanqueExerciceORM.session == session)
    # Les valeurs sont des listes JSON en texte : LIKE/contains donnerait des
    # faux positifs (par exemple « A » dans « BAC »). Comparaison exacte ici.
    rows = exercices_q.order_by(BanqueExerciceORM.created_at.desc()).all()
    if matiere:
        rows = [r for r in rows if matiere in _json_list(r.matieres_json)]
    if classe:
        rows = [r for r in rows if classe in _json_list(r.classes_json)]
    if recherche:
        needle = recherche.casefold()
        rows = [r for r in rows if needle in r.sujet.casefold() or needle in r.corrige.casefold()]
    rows = rows[:1000]
    return {
        "parties": [_partie_out(p) for p in parties],
        "exercices": [_exercice_out(r) for r in rows],
        "classes_meta": {
            r.classe: {"a_examen": r.a_examen, "specialite_obligatoire": r.specialite_obligatoire}
            for r in db.query(BanqueClasseMetaORM).all()
        },
        "referentiel": {
            **{
                scope: [r.code for r in db.query(ReferentielOptionORM).filter(ReferentielOptionORM.scope == scope).order_by(ReferentielOptionORM.position).all()]
                for scope in ("matiere", "classe", "serie")
            },
            "sequences": [int(value[len("SEQUENCE "):]) for value in referentiel.EVALUATIONS if value.startswith("SEQUENCE ")],
        },
    }


@router.post("/parties")
def creer_partie(payload: PartieIn, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    if payload.matiere not in _codes_referentiel(db, "matiere"):
        raise HTTPException(422, "Matière inconnue du référentiel")
    row = BanquePartieORM(matiere=payload.matiere, nom=payload.nom, ordre=payload.ordre)
    db.add(row)
    try:
        db.flush()
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "Une partie porte déjà ce nom pour cette matière") from exc
    log_admin_event(db, None, "banque_partie_creee", lock.email, _partie_out(row))
    return _partie_out(row)


@router.patch("/parties/{partie_id}")
def modifier_partie(partie_id: str, payload: PartieIn, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    row = _partie(db, partie_id)
    if payload.matiere not in _codes_referentiel(db, "matiere"):
        raise HTTPException(422, "Matière inconnue du référentiel")
    old_matiere = row.matiere
    if payload.matiere != old_matiere:
        used_elsewhere = db.query(BanqueExerciceORM.id).filter(BanqueExerciceORM.partie_id == row.id).first()
        if used_elsewhere:
            raise HTTPException(409, "Réaffectez les exercices avant de déplacer cette partie")
    row.matiere, row.nom, row.ordre = payload.matiere, payload.nom, payload.ordre
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "Une partie porte déjà ce nom pour cette matière") from exc
    log_admin_event(db, None, "banque_partie_modifiee", lock.email, _partie_out(row))
    return _partie_out(row)


@router.delete("/parties/{partie_id}")
def supprimer_partie(partie_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    row = _partie(db, partie_id)
    if db.query(func.count(BanquePartieORM.id)).filter(BanquePartieORM.matiere == row.matiere).scalar() <= 1:
        raise HTTPException(409, "Impossible de supprimer la dernière partie d'une matière")
    if db.query(BanqueExerciceORM.id).filter(BanqueExerciceORM.partie_id == row.id).first():
        raise HTTPException(409, "Cette partie contient des exercices : réaffectez-les avant suppression")
    details = _partie_out(row)
    db.delete(row)
    db.commit()
    log_admin_event(db, None, "banque_partie_supprimee", lock.email, details)
    return {"ok": True}


@router.post("/exercices")
def creer_exercice(payload: ExerciceIn, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    data = _validate_exercise(db, payload.model_dump())
    row = BanqueExerciceORM(
        id=_uuid_hex(data.get("id"), optional=True), sujet=data["sujet"], corrige=data["corrige"],
        partie_id=data["partie_id"], session=data["session"], niveau_intrinseque=data["niveau_intrinseque"],
        tag_examen=data["tag_examen"], actif=data["actif"], matieres_json=json.dumps(data["matieres"], ensure_ascii=False),
        classes_json=json.dumps(data["classes"], ensure_ascii=False), series_json=json.dumps(data["series"], ensure_ascii=False),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "Cet identifiant d'exercice existe déjà") from exc
    log_admin_event(db, None, "banque_exercice_cree", lock.email, {"id": row.id, "partie_id": row.partie_id})
    return _exercice_out(row)


@router.put("/exercices/{exercice_id}")
def modifier_exercice(exercice_id: str, payload: ExerciceIn, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    row = db.get(BanqueExerciceORM, _uuid_hex(exercice_id))
    if row is None:
        raise HTTPException(404, "Exercice introuvable")
    data = _validate_exercise(db, payload.model_dump(exclude={"id"}))
    for field, value in (("sujet", data["sujet"]), ("corrige", data["corrige"]), ("partie_id", data["partie_id"]),
                         ("session", data["session"]), ("niveau_intrinseque", data["niveau_intrinseque"]),
                         ("tag_examen", data["tag_examen"]), ("actif", data["actif"])):
        setattr(row, field, value)
    row.matieres_json = json.dumps(data["matieres"], ensure_ascii=False)
    row.classes_json = json.dumps(data["classes"], ensure_ascii=False)
    row.series_json = json.dumps(data["series"], ensure_ascii=False)
    db.commit()
    log_admin_event(db, None, "banque_exercice_modifie", lock.email, {"id": row.id})
    return _exercice_out(row)


@router.delete("/exercices/{exercice_id}")
def supprimer_exercice(exercice_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    row = db.get(BanqueExerciceORM, _uuid_hex(exercice_id))
    if row is None:
        raise HTTPException(404, "Exercice introuvable")
    db.delete(row)
    db.commit()
    log_admin_event(db, None, "banque_exercice_supprime", lock.email, {"id": row.id})
    return {"ok": True}


@router.put("/classes/{classe}")
def definir_meta_classe(classe: str, payload: ClasseMetaIn, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    if classe not in _codes_referentiel(db, "classe"):
        raise HTTPException(422, "Classe inconnue du référentiel")
    row = db.get(BanqueClasseMetaORM, classe)
    if row is None:
        row = BanqueClasseMetaORM(classe=classe)
        db.add(row)
    row.a_examen = payload.a_examen
    row.specialite_obligatoire = payload.specialite_obligatoire
    db.commit()
    result = {"classe": classe, **payload.model_dump()}
    log_admin_event(db, None, "banque_classe_meta_modifiee", lock.email, result)
    return result


@router.get("/journal")
def lire_journal(
    type_evenement: str | None = Query(default=None, alias="type"),
    user_id: str | None = None,
    depuis: datetime | None = None,
    jusqua: datetime | None = None,
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> list[dict]:
    q = db.query(BanqueJournalORM)
    if type_evenement:
        q = q.filter(BanqueJournalORM.type == type_evenement)
    if user_id:
        q = q.filter(BanqueJournalORM.user_id == user_id)
    if depuis:
        q = q.filter(BanqueJournalORM.created_at >= depuis)
    if jusqua:
        q = q.filter(BanqueJournalORM.created_at <= jusqua)
    rows = q.order_by(BanqueJournalORM.created_at.desc()).limit(limit).all()
    return [{"id": r.id, "user_id": r.user_id, "generation_id": r.generation_id, "type": r.type,
             "params": json.loads(r.params_json), "details": json.loads(r.details_json), "created_at": r.created_at} for r in rows]


def _snapshot(db: Session) -> dict[str, Any]:
    return {
        "schemaVersion": "1.0",
        "exportedAt": utc_now().isoformat(),
        "matieres": [{"id": r.code, "nom": r.label or r.code} for r in db.query(ReferentielOptionORM).filter(ReferentielOptionORM.scope == "matiere").order_by(ReferentielOptionORM.position).all()],
        "parties": [{"id": r.id, "matiereId": r.matiere, "nom": r.nom, "ordre": r.ordre} for r in db.query(BanquePartieORM).order_by(BanquePartieORM.matiere, BanquePartieORM.ordre).all()],
        "classes": [{"id": r.code, "nom": r.label or r.code,
                     "aExamen": bool((meta := db.get(BanqueClasseMetaORM, r.code)) and meta.a_examen),
                     "specialiteObligatoire": bool(meta and meta.specialite_obligatoire)}
                    for r in db.query(ReferentielOptionORM).filter(ReferentielOptionORM.scope == "classe").order_by(ReferentielOptionORM.position).all()],
        "specialites": [{"id": r.code, "nom": r.label or r.code} for r in db.query(ReferentielOptionORM).filter(ReferentielOptionORM.scope == "serie").order_by(ReferentielOptionORM.position).all()],
        "exercices": [{"id": r.id, "sujet": r.sujet, "corrige": r.corrige,
                       "matiereIds": _json_list(r.matieres_json), "classeIds": _json_list(r.classes_json),
                       "specialiteIds": _json_list(r.series_json), "partieId": r.partie_id,
                       "session": r.session, "niveauIntrinseque": r.niveau_intrinseque,
                       "tagExamen": r.tag_examen, "actif": r.actif}
                      for r in db.query(BanqueExerciceORM).order_by(BanqueExerciceORM.id).all()],
    }


@router.get("/export")
def exporter(db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    return _snapshot(db)


def _validate_snapshot(db: Session, snapshot: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Valide tout le snapshot avant toute mutation.

    Le référentiel est partagé avec les autres fonctions du site : un import de
    banque peut référencer ses options, mais ne peut ni créer ni supprimer des
    matières/classes/spécialités globales.
    """
    if snapshot.get("schemaVersion") != "1.0":
        raise HTTPException(422, "Version de snapshot inconnue")
    expected = ("matieres", "parties", "classes", "specialites", "exercices")
    if any(not isinstance(snapshot.get(key), list) for key in expected):
        raise HTTPException(422, "Snapshot incomplet")
    limits = {"matieres": 500, "parties": 5000, "classes": 500, "specialites": 500, "exercices": 10000}
    if any(len(snapshot[key]) > limits[key] for key in expected):
        raise HTTPException(422, "Snapshot trop volumineux")

    normalized = {key: list(snapshot[key]) for key in expected}
    scopes = {"matieres": "matiere", "classes": "classe", "specialites": "serie"}
    known = {
        key: _codes_referentiel(db, scope)
        for key, scope in scopes.items()
    }
    maps: dict[str, dict[str, str]] = {"parties": {}, "exercices": {}}
    for key in expected:
        for row in normalized[key]:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"].strip():
                raise HTTPException(422, "Entité ou identifiant manquant")
            if key in scopes:
                code = row["id"]
                if code not in known[key]:
                    raise HTTPException(422, "Le snapshot référence une option absente du référentiel actuel")
                if key == "classes":
                    for field in ("aExamen", "specialiteObligatoire"):
                        if field in row and not isinstance(row[field], bool):
                            raise HTTPException(422, "Métadonnée de classe invalide")
                continue
            old_id = row["id"]
            new_id = _uuid_hex(old_id)
            if old_id in maps[key]:
                raise HTTPException(422, "Identifiant dupliqué dans le snapshot")
            maps[key][old_id] = new_id

    known_part_ids = set(maps["parties"])
    for part in normalized["parties"]:
        if part.get("matiereId") not in known["matieres"]:
            raise HTTPException(422, "Une partie référence une matière absente du référentiel")
        if not isinstance(part.get("nom"), str) or not part["nom"].strip() or len(part["nom"]) > 160:
            raise HTTPException(422, "Nom de partie invalide")
        ordre = part.get("ordre", 0)
        if isinstance(ordre, bool) or not isinstance(ordre, int) or not 0 <= ordre <= 10000:
            raise HTTPException(422, "Ordre de partie invalide")
        part["id"] = maps["parties"][part["id"]]

    required_text = ("sujet", "corrige")
    for exercise in normalized["exercices"]:
        for field in required_text:
            value = exercise.get(field)
            if not isinstance(value, str) or not value.strip() or len(value) > 100_000:
                raise HTTPException(422, "Contenu d'exercice invalide")
        part_ref = exercise.get("partieId")
        if part_ref not in known_part_ids:
            raise HTTPException(422, "Un exercice référence une partie absente")
        lists = ("matiereIds", "classeIds", "specialiteIds")
        if any(not isinstance(exercise.get(field), list) or not all(isinstance(v, str) for v in exercise[field]) for field in lists):
            raise HTTPException(422, "Métadonnées d'exercice invalides")
        matieres, classes, series = (exercise[field] for field in lists)
        if not matieres or not classes or any(len(values) > 20 or len(set(values)) != len(values) for values in (matieres, classes, series)):
            raise HTTPException(422, "Métadonnées d'exercice invalides")
        if not set(matieres) <= known["matieres"] or not set(classes) <= known["classes"]:
            raise HTTPException(422, "Un exercice référence une option absente du référentiel actuel")
        if not (set(series) - {SPECIAL_AUCUNE}) <= known["specialites"]:
            raise HTTPException(422, "Une spécialité référencée est absente du référentiel actuel")
        part_source = next(row for row in normalized["parties"] if row["id"] == maps["parties"][part_ref])
        if part_source["matiereId"] not in matieres:
            raise HTTPException(422, "La matière de la partie doit être présente dans l'exercice")
        session = exercise.get("session")
        if session is not None and (isinstance(session, bool) or not isinstance(session, int) or not 1 <= session <= SESSIONS_CONNNUES):
            raise HTTPException(422, "Session hors du référentiel")
        tag_examen = exercise.get("tagExamen", False)
        actif = exercise.get("actif", True)
        if not isinstance(tag_examen, bool) or not isinstance(actif, bool):
            raise HTTPException(422, "Options d'exercice invalides")
        if session is None and tag_examen:
            raise HTTPException(422, "tagExamen doit être faux si session est vide")
        niveau = exercise.get("niveauIntrinseque", "Moyen")
        if niveau not in DIFFICULTES:
            raise HTTPException(422, "Niveau intrinsèque invalide")
        exercise["id"] = maps["exercices"][exercise["id"]]
        exercise["partieId"] = maps["parties"][part_ref]
        exercise["niveauIntrinseque"] = niveau

    return normalized


@router.post("/import")
def importer(payload: ImportIn, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    data = _validate_snapshot(db, payload.snapshot)
    try:
        if payload.mode == "remplacer":
            db.query(BanqueExerciceORM).delete(synchronize_session=False)
            db.query(BanquePartieORM).delete(synchronize_session=False)
            db.query(BanqueClasseMetaORM).delete(synchronize_session=False)
        for row in data["parties"]:
            part = db.get(BanquePartieORM, row["id"])
            if part is None:
                part = BanquePartieORM(id=row["id"], matiere=row["matiereId"], nom=row["nom"], ordre=row.get("ordre", 0))
                db.add(part)
            else:
                part.matiere, part.nom, part.ordre = row["matiereId"], row["nom"], row.get("ordre", 0)
        db.flush()
        if payload.mode == "remplacer":
            incoming_parts = {row["id"] for row in data["parties"]}
            incoming_exercises = {row["id"] for row in data["exercices"]}
            db.query(BanqueExerciceORM).filter(BanqueExerciceORM.id.notin_(incoming_exercises or {"__none__"})).delete(synchronize_session=False)
            db.query(BanquePartieORM).filter(BanquePartieORM.id.notin_(incoming_parts or {"__none__"})).delete(synchronize_session=False)
            keep_classes = {row["id"] for row in data["classes"]}
            db.query(BanqueClasseMetaORM).filter(BanqueClasseMetaORM.classe.notin_(keep_classes or {"__none__"})).delete(synchronize_session=False)
        for row in data["classes"]:
            meta = db.get(BanqueClasseMetaORM, row["id"])
            if meta is None:
                db.add(BanqueClasseMetaORM(classe=row["id"], a_examen=bool(row.get("aExamen")), specialite_obligatoire=bool(row.get("specialiteObligatoire"))))
            else:
                meta.a_examen = bool(row.get("aExamen"))
                meta.specialite_obligatoire = bool(row.get("specialiteObligatoire"))
        for row in data["exercices"]:
            ex = db.get(BanqueExerciceORM, row["id"])
            fields = (row["sujet"], row["corrige"], row["partieId"], row.get("session"), row.get("niveauIntrinseque", "Moyen"), bool(row.get("tagExamen", False)), bool(row.get("actif", True)), json.dumps(row["matiereIds"], ensure_ascii=False), json.dumps(row["classeIds"], ensure_ascii=False), json.dumps(row["specialiteIds"], ensure_ascii=False))
            if ex is None:
                ex = BanqueExerciceORM(id=row["id"])
                db.add(ex)
            (ex.sujet, ex.corrige, ex.partie_id, ex.session, ex.niveau_intrinseque, ex.tag_examen, ex.actif, ex.matieres_json, ex.classes_json, ex.series_json) = fields
        db.commit()
    except (IntegrityError, ValueError, KeyError, TypeError) as exc:
        db.rollback()
        raise HTTPException(422, "Snapshot invalide ou incompatible") from exc
    log_admin_event(db, None, "banque_import", lock.email, {"mode": payload.mode, "exercices": len(data["exercices"])})
    return {"ok": True, "mode": payload.mode, "exercices": len(data["exercices"]), "parties": len(data["parties"])}
