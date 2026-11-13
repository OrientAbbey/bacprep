"""Gabarits d'exercices — back-office : relire les gabarits, VALIDER (ou
retirer la validation), traiter les signalements des élèves.

Un enseignant relit des variantes rendues (aperçu avec correction), regarde le
rapport automatique, puis valide : seul ce geste rend un gabarit public. Le
serveur refuse de valider un gabarit dont le rapport automatique échoue. La
validation est liée au hash du contenu (`core/gabarits.py`)."""
from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..core import gabarits as gab
from ..db import get_db, utc_now
from ..db_models import GabaritSignalementORM, GabaritValidationORM, UserORM
from .deps import log_admin_event, require_admin

router = APIRouter(prefix="/api/admin/gabarits", tags=["admin-gabarits"])

N_RAPPORT = 100  # graines essayées par le rapport automatique


def _gabarit_ou_404(gabarit_id: str) -> gab.Gabarit:
    g = gab.tous()[0].get(gabarit_id)
    if g is None:
        raise HTTPException(404, "Gabarit introuvable")
    return g


def _statut(g: gab.Gabarit, validation: GabaritValidationORM | None) -> str:
    if validation is None:
        return "a_valider"
    return "valide" if validation.hash_contenu == g.hash else "modifie"


@router.get("")
def lister(db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    valides, invalides = gab.tous()
    validations = {v.gabarit_id: v for v in db.query(GabaritValidationORM).all()}
    ouverts: dict[str, int] = {}
    for (gid,) in db.query(GabaritSignalementORM.gabarit_id).filter(GabaritSignalementORM.statut == "ouvert").all():
        ouverts[gid] = ouverts.get(gid, 0) + 1
    lignes = []
    for gid, g in sorted(valides.items()):
        v = validations.get(gid)
        lignes.append(
            {
                **g.resume(),
                "statut": _statut(g, v),
                "valide_par": v.valide_par if v else None,
                "valide_le": v.valide_le if v else None,
                "rapport": gab.rapport_validation(g, N_RAPPORT),
                "signalements_ouverts": ouverts.get(gid, 0),
            }
        )
    return {"gabarits": lignes, "fichiers_invalides": invalides}


@router.get("/signalements")
def signalements(
    statut: str = Query(default="ouvert", pattern="^(ouvert|resolu|tous)$"),
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> list[dict]:
    q = db.query(GabaritSignalementORM)
    if statut != "tous":
        q = q.filter(GabaritSignalementORM.statut == statut)
    rows = q.order_by(GabaritSignalementORM.created_at.desc()).limit(200).all()
    emails = {u.id: u.email for u in db.query(UserORM).filter(UserORM.id.in_({r.user_id for r in rows} or {""})).all()}
    tous = gab.tous()[0]
    return [
        {
            "id": r.id,
            "gabarit_id": r.gabarit_id,
            "titre": tous[r.gabarit_id].titre if r.gabarit_id in tous else r.gabarit_id,
            "graine": r.graine,
            "message": r.message,
            "statut": r.statut,
            "email": emails.get(r.user_id, ""),
            "created_at": r.created_at,
        }
        for r in rows
    ]


@router.post("/signalements/{signalement_id}/resoudre")
def resoudre(signalement_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    r = db.query(GabaritSignalementORM).filter(GabaritSignalementORM.id == signalement_id).one_or_none()
    if r is None:
        raise HTTPException(404, "Signalement introuvable")
    r.statut, r.resolved_at = "resolu", utc_now()
    db.commit()
    log_admin_event(db, None, "gabarit_signalement_resolu", lock.email, {"gabarit": r.gabarit_id, "graine": r.graine})
    return {"ok": True}


@router.get("/{gabarit_id}/apercu")
def apercu(
    gabarit_id: str,
    graine: int | None = Query(default=None, ge=0, le=gab.GRAINE_MAX),
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Une variante AVEC sa correction, même pour un gabarit pas encore validé :
    c'est ce que l'enseignant relit."""
    g = _gabarit_ou_404(gabarit_id)
    graine = secrets.randbelow(gab.GRAINE_MAX + 1) if graine is None else graine
    try:
        return g.instancier(graine)
    except gab.GabaritError as exc:
        raise HTTPException(422, f"Cette graine échoue : {exc}") from exc


@router.post("/{gabarit_id}/validation")
def valider(gabarit_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    g = _gabarit_ou_404(gabarit_id)
    if not gab.rapport_validation(g, N_RAPPORT)["ok"]:
        raise HTTPException(409, "Le contrôle automatique de ce gabarit a échoué : il ne peut pas être validé.")
    v = db.get(GabaritValidationORM, gabarit_id)
    if v is None:
        db.add(GabaritValidationORM(gabarit_id=gabarit_id, hash_contenu=g.hash, valide_par=lock.email))
    else:
        v.hash_contenu, v.valide_par, v.valide_le = g.hash, lock.email, utc_now()
    db.commit()
    log_admin_event(db, None, "gabarit_valide", lock.email, {"gabarit": gabarit_id, "hash": g.hash[:12]})
    return {"ok": True}


@router.delete("/{gabarit_id}/validation")
def retirer(gabarit_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    _gabarit_ou_404(gabarit_id)
    n = db.query(GabaritValidationORM).filter(GabaritValidationORM.gabarit_id == gabarit_id).delete()
    db.commit()
    if n:
        log_admin_event(db, None, "gabarit_validation_retiree", lock.email, {"gabarit": gabarit_id})
    return {"ok": True}
