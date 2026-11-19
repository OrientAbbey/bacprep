"""Génération d'épreuves personnelles depuis la banque V4.10.

Les événements de diagnostic restent en base et ne sont jamais inclus dans
les réponses élève : l'incomplétude et les contraintes relâchées sont muettes.
"""
from __future__ import annotations

import json
import os
import random
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.orm import Session

from ..core import referentiel, referentiel_options, store
from ..core.banque_generation import (
    GENERATION,
    MAX_TENTATIVES,
    ClasseMeta,
    ExerciceBanque,
    Parametres,
    SPECIAL_AUCUNE,
    canonique,
    generer,
)
from ..core.rate_limit import SlidingWindowLimiter, client_ip
from ..db import get_db, utc_now
from ..db_models import (
    BanqueClasseMetaORM,
    BanqueImageORM,
    BanqueExerciceORM,
    BanqueGenerationORM,
    BanqueJournalORM,
    ReferentielOptionORM,
)
from .auth import require_user

router = APIRouter(prefix="/api/banque", tags=["banque"])
RETENTION = timedelta(days=365)


@router.get("/images/{image_id}")
def image_banque(image_id: str, db: Session = Depends(get_db)) -> Response:
    """Illustration d'un exercice de la Banque (figure, graphique, schéma).

    Les identifiants sont aléatoires et l'URL est publique : l'image doit
    pouvoir s'afficher dans l'épreuve générée, y compris pour un élève qui
    n'a pas de session. Aucune donnée personnelle n'est exposée.
    """
    ligne = db.get(BanqueImageORM, image_id)
    if ligne is None:
        raise HTTPException(404, "Image introuvable")
    from ..core.storage import StorageError, get_storage

    try:
        data = get_storage().get_bytes(ligne.storage_key)
    except StorageError:
        raise HTTPException(404, "Image introuvable")
    return Response(
        content=data,
        media_type=ligne.mime_type or "application/octet-stream",
        headers={"Cache-Control": "public, max-age=86400"},
    )


def _retention_configurable(nom_env: str, defaut_jours: int) -> timedelta | None:
    """Durée de conservation configurable : valeur absente ou invalide = défaut ;
    0 ou négatif = conservation illimitée (l'administration l'assume)."""
    brut = os.getenv(nom_env, "").strip()
    if not brut:
        return timedelta(days=defaut_jours)
    try:
        jours = int(brut)
    except ValueError:
        return timedelta(days=defaut_jours)
    return None if jours <= 0 else timedelta(days=jours)


# Le journal technique contient un identifiant utilisateur et les paramètres de
# génération : sa conservation est bornée (365 jours par défaut, configurable,
# 0 = illimité) et distincte de celle des générations.
JOURNAL_RETENTION = _retention_configurable("BANQUE_JOURNAL_RETENTION_JOURS", 365)
_limiteur = SlidingWindowLimiter(
    max_attempts=30,
    window_seconds=300.0,
    message="Trop de demandes d'épreuves — réessaie dans quelques minutes",
    env_switch="ENTRAINEMENT_RATE_LIMIT",
)


def _json_list(raw: str) -> list[str]:
    try:
        value = json.loads(raw)
        return value if isinstance(value, list) else []
    except (TypeError, json.JSONDecodeError):
        return []


def _parametres_out(p: Parametres) -> dict:
    return {
        "matiere": p.matiere,
        "classe": p.classe,
        "serie": p.serie,
        "sequence": p.sequence,
        "mode": p.mode,
        "difficulte": p.difficulte,
        "nb_exercices": p.n,
    }


def _journal(db: Session, user_id: str, generation_id: str, kind: str, params: dict, details: dict | None = None) -> None:
    db.add(
        BanqueJournalORM(
            user_id=user_id,
            generation_id=generation_id,
            type=kind,
            params_json=json.dumps(params, ensure_ascii=False),
            details_json=json.dumps(details or {}, ensure_ascii=False),
        )
    )


def _purger_historique(db: Session, now) -> None:
    """Purge les générations vieilles de 12 mois, en préservant la plus
    récente de chaque élève et en inscrivant chaque purge au journal admin."""
    cutoff = now - RETENTION
    stale_users = [
        row[0]
        for row in db.query(BanqueGenerationORM.user_id)
        .filter(BanqueGenerationORM.created_at < cutoff)
        .distinct()
        .all()
    ]
    for user_id in stale_users:
        latest = (
            db.query(BanqueGenerationORM.id)
            .filter(BanqueGenerationORM.user_id == user_id)
            .order_by(BanqueGenerationORM.created_at.desc(), BanqueGenerationORM.id.desc())
            .first()
        )
        latest_id = latest[0] if latest else None
        q = db.query(BanqueGenerationORM).filter(
            BanqueGenerationORM.user_id == user_id,
            BanqueGenerationORM.created_at < cutoff,
        )
        if latest_id:
            q = q.filter(BanqueGenerationORM.id != latest_id)
        count = q.count()
        if count:
            q.delete(synchronize_session=False)
            _journal(
                db,
                user_id,
                latest_id or "",
                "INFO_HISTORY_PURGED",
                {},
                {"deleted": count},
            )
    if JOURNAL_RETENTION is not None:
        cutoff_journal = now - JOURNAL_RETENTION
        # Les entrées techniques vieilles de plus de la durée de conservation
        # sont supprimées. La trace de la purge est remontée sous un identifiant
        # système, non rattaché à un élève.
        nb_journal = (
            db.query(BanqueJournalORM)
            .filter(BanqueJournalORM.created_at < cutoff_journal)
            .delete(synchronize_session=False)
        )
        if nb_journal:
            _journal(
                db,
                "",
                "",
                "INFO_JOURNAL_PURGED",
                {},
                {"deleted": nb_journal, "retention_jours": JOURNAL_RETENTION.days},
            )


def _history(db: Session, user_id: str) -> set[tuple[str, ...]]:
    result: set[tuple[str, ...]] = set()
    for (raw,) in (
        db.query(BanqueGenerationORM.exercices_json)
        .filter(BanqueGenerationORM.user_id == user_id)
        .all()
    ):
        try:
            values = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(values, list):
            continue
        ids = [value["id"] if isinstance(value, dict) and isinstance(value.get("id"), str) else value
               for value in values if isinstance(value, str) or (isinstance(value, dict) and isinstance(value.get("id"), str))]
        result.add(canonique(ids))
    return result


class GenerationIn(BaseModel):
    matiere: str = Field(min_length=1, max_length=120)
    classe: str = Field(min_length=1, max_length=80)
    serie: str | None = Field(default=None, max_length=80)
    sequence: int | None = Field(default=None, ge=1)
    mode: str = "sequence"
    difficulte: str = "Moyen"

    @model_validator(mode="after")
    def sequence_consistency(self):
        if self.mode == "sequence" and self.sequence is None:
            raise ValueError("Une séquence est requise pour ce mode")
        if self.mode != "sequence" and self.sequence is not None:
            raise ValueError("La séquence ne s'applique qu'au mode séquence")
        return self


def _valider_referentiel(db: Session, payload: GenerationIn) -> tuple[tuple[str, ...], tuple[str, ...]]:
    scopes = {scope: {r.code for r in db.query(ReferentielOptionORM).filter(ReferentielOptionORM.scope == scope).all()}
              for scope in ("matiere", "classe", "serie")}
    if payload.matiere not in scopes["matiere"] or payload.classe not in scopes["classe"]:
        raise HTTPException(422, "Sélection invalide")
    if payload.serie is not None and payload.serie not in scopes["serie"]:
        raise HTTPException(422, "Sélection invalide")
    # Spécialité obligatoire : la métadonnée de classe impose le choix d'une
    # spécialité, même si l'appel contourne l'interface élève.
    meta = db.get(BanqueClasseMetaORM, payload.classe)
    if meta is not None and meta.specialite_obligatoire and payload.serie is None:
        raise HTTPException(422, "Sélection invalide")
    classes = tuple(
        row.code
        for row in db.query(ReferentielOptionORM)
        .filter(ReferentielOptionORM.scope == "classe")
        .order_by(ReferentielOptionORM.position, ReferentielOptionORM.code)
        .all()
    )
    sequences = tuple(f"SEQUENCE {n}" for n in referentiel_options.sequences_du_referentiel(db))
    return classes, sequences


def _series_accessibles(db: Session, user_id: str, p: GenerationIn) -> tuple[str, ...]:
    """Séries réelles couvertes par un abonnement matière/classe actif."""
    return tuple(
        filiere
        for filiere in referentiel.SERIES_CONNUES
        if store.scope_already_covered(
            db,
            user_id,
            "matiere",
            filiere=filiere,
            matiere=p.matiere,
            classe=p.classe,
        )
    )


def _access_granted(db: Session, user_id: str, p: GenerationIn) -> bool:
    """Vérifie l'abonnement à la matière dans la spécialité demandée.

    Sans spécialité sélectionnée, toute série couverte ouvre la composition,
    mais la banque est ensuite limitée à ces séries (et aux exercices communs).
    L'achat API conserve toujours une filière réelle : aucun joker `ALL` n'est
    créé pour cette portée.
    """
    if p.serie is not None:
        return store.scope_already_covered(
            db,
            user_id,
            "matiere",
            filiere=p.serie,
            matiere=p.matiere,
            classe=p.classe,
        )
    return bool(_series_accessibles(db, user_id, p))


def _to_exercice(row: BanqueExerciceORM) -> ExerciceBanque:
    return ExerciceBanque(
        id=row.id,
        partie_id=row.partie_id,
        classes=tuple(_json_list(row.classes_json)),
        matieres=tuple(_json_list(row.matieres_json)),
        series=tuple(_json_list(row.series_json)),
        session=row.session,
        niveau=row.niveau_intrinseque,
        tag_examen=row.tag_examen,
    )


def _generation_response(row: BanqueGenerationORM, db: Session, *, corrige: bool) -> dict:
    try:
        saved = json.loads(row.exercices_json)
        params = json.loads(row.params_json)
    except (TypeError, json.JSONDecodeError):
        raise HTTPException(404, "Épreuve introuvable")
    # Les nouvelles générations contiennent leur snapshot (énoncé/corrigé),
    # les anciennes restent lisibles si elles ne portent que des identifiants.
    if not isinstance(saved, list) or not isinstance(params, dict):
        raise HTTPException(404, "Épreuve introuvable")
    if saved and isinstance(saved[0], str):
        ids = [value for value in saved if isinstance(value, str)]
        rows = {r.id: r for r in db.query(BanqueExerciceORM).filter(BanqueExerciceORM.id.in_(ids)).all()}
        saved = [{"id": eid, "sujet": rows[eid].sujet, "corrige": rows[eid].corrige} for eid in ids if eid in rows]
    if any(not isinstance(item, dict) or not isinstance(item.get("sujet"), str) or not isinstance(item.get("corrige"), str) for item in saved):
        raise HTTPException(404, "Épreuve introuvable")
    exercises = [
        {"numero": i, "contenu": item["corrige"] if corrige else item["sujet"]}
        for i, item in enumerate(saved, 1)
    ]
    return {"generation_id": row.id, "exercices": exercises, "parametres": params}


@router.get("/options")
def options_generation(
    db: Session = Depends(get_db),
    user=Depends(require_user),
) -> dict:
    """Matières qui ont au moins un exercice actif, sans exposer le contenu."""
    matieres_banque: set[str] = set()
    classes_banque: set[str] = set()
    series_banque: set[str] = set()
    for matieres_raw, classes_raw, series_raw in (
        db.query(
            BanqueExerciceORM.matieres_json,
            BanqueExerciceORM.classes_json,
            BanqueExerciceORM.series_json,
        )
        .filter(BanqueExerciceORM.actif.is_(True))
        .all()
    ):
        matieres_banque.update(_json_list(matieres_raw))
        classes_banque.update(_json_list(classes_raw))
        series_banque.update(_json_list(series_raw))

    def codes_disponibles(scope: str, disponibles: set[str]) -> list[str]:
        return [
            row.code
            for row in db.query(ReferentielOptionORM)
            .filter(ReferentielOptionORM.scope == scope)
            .order_by(ReferentielOptionORM.position, ReferentielOptionORM.code)
            .all()
            if row.code in disponibles
        ]

    classes = codes_disponibles("classe", classes_banque)
    return {
        "matieres": codes_disponibles("matiere", matieres_banque),
        "classes": classes,
        "classes_meta": {
            row.classe: {"specialite_obligatoire": row.specialite_obligatoire}
            for row in db.query(BanqueClasseMetaORM).filter(BanqueClasseMetaORM.classe.in_(classes)).all()
        },
        "series": codes_disponibles("serie", series_banque - {SPECIAL_AUCUNE}),
        "sequences": referentiel_options.sequences_du_referentiel(db),
    }


@router.post("/generer")
def generer_epreuve(
    payload: GenerationIn,
    request: Request,
    db: Session = Depends(get_db),
    user=Depends(require_user),
) -> dict:
    _limiteur.check(client_ip(request))
    if payload.mode not in ("sequence", "examen", "examen_blanc", "vide") or payload.difficulte not in ("Facile", "Moyen", "Difficile"):
        raise HTTPException(422, "Sélection invalide")
    classes, sequences = _valider_referentiel(db, payload)
    if payload.sequence is not None and f"SEQUENCE {payload.sequence}" not in sequences:
        raise HTTPException(422, "Sélection invalide")
    if not _access_granted(db, user.id, payload):
        raise HTTPException(403, "Cette matière n'est pas incluse dans un abonnement actif.")
    try:
        params = Parametres(
            matiere=payload.matiere,
            classe=payload.classe,
            serie=payload.serie,
            sequence=payload.sequence,
            mode=payload.mode,
            difficulte=payload.difficulte,
            sequences_connues=sequences,
            classes=classes,
            classes_meta={
                row.classe: ClasseMeta(row.a_examen, row.specialite_obligatoire)
                for row in db.query(BanqueClasseMetaORM).all()
            },
        )
    except ValueError as exc:
        raise HTTPException(422, "Sélection invalide") from exc

    now = utc_now()
    _purger_historique(db, now)
    historique = _history(db, user.id)
    rows = db.query(BanqueExerciceORM).filter(BanqueExerciceORM.actif.is_(True)).all()
    pool = [_to_exercice(row) for row in rows]
    if params.serie is None:
        series_accessibles = set(_series_accessibles(db, user.id, payload))
        # No selected specialty is not an unrestricted pass: common exercises
        # remain eligible, while specialty-specific content is limited to the
        # student's active subscriptions.
        pool = [
            exercise for exercise in pool
            if not exercise.series
            or SPECIAL_AUCUNE in exercise.series
            or series_accessibles.intersection(exercise.series)
        ]
    tires, events = generer(pool, params, random.Random(), historique, MAX_TENTATIVES)
    generation_id = uuid.uuid4().hex
    params_json = _parametres_out(params)
    content_by_id = {row.id: row for row in rows}
    snapshot = [
        {"id": ex.id, "sujet": content_by_id[ex.id].sujet, "corrige": content_by_id[ex.id].corrige}
        for ex in tires
    ]
    generation = BanqueGenerationORM(
        id=generation_id,
        user_id=user.id,
        params_json=json.dumps(params_json, ensure_ascii=False),
        exercices_json=json.dumps(snapshot, ensure_ascii=False),
        created_at=now,
    )
    db.add(generation)
    _journal(db, user.id, generation_id, GENERATION, params_json, {"count": len(tires), "expected": params.n})
    for event in events:
        _journal(db, user.id, generation_id, event, params_json)
    db.commit()
    return {
        "generation_id": generation_id,
        "exercices": [{"numero": i, "sujet": item["sujet"]} for i, item in enumerate(snapshot, 1)],
        "parametres": params_json,
    }


@router.get("/generations/{generation_id}")
def lire_generation(
    generation_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user=Depends(require_user),
) -> dict:
    _limiteur.check(client_ip(request))
    row = db.get(BanqueGenerationORM, generation_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(404, "Épreuve introuvable")
    return _generation_response(row, db, corrige=False)


@router.get("/generations/{generation_id}/corrige")
def lire_corrige(
    generation_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user=Depends(require_user),
) -> dict:
    _limiteur.check(client_ip(request))
    row = db.get(BanqueGenerationORM, generation_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(404, "Épreuve introuvable")
    return _generation_response(row, db, corrige=True)
