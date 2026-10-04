"""Examens blancs (essais notés) et révision espacée.

La révision espacée n'a pas de table de planning : la prochaine échéance d'une
épreuve est CALCULÉE à partir de son dernier essai (date + intervalle selon la
note)."""
from __future__ import annotations

from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db, utc_now
from ..db_models import EpreuveORM, EssaiORM
from .auth import require_user
from .deps import get_public_epreuve_or_404

router = APIRouter(prefix="/api/me", tags=["essais"])


class EssaiIn(BaseModel):
    epreuve_id: str = Field(max_length=64)
    note: Optional[float] = Field(default=None, ge=0, le=20)  # vide = « à revoir » sans note
    duree_s: Optional[int] = Field(default=None, ge=0, le=86400)


def intervalle_jours(note: Optional[float], nb_essais: int) -> int:
    """Jours avant la prochaine révision : plus la note est basse, plus c'est court."""
    if note is None:
        return 3
    if note < 10:
        return 1
    if note < 14:
        return 3
    if note < 16:
        return 7
    return 30 if nb_essais >= 3 else 14


def _label(e: EpreuveORM) -> dict:
    return {"epreuve_id": e.id, "matiere": e.matiere, "annee": e.annee, "evaluation": e.evaluation, "classe": e.classe}


@router.post("/essais")
def enregistrer(payload: EssaiIn, db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    get_public_epreuve_or_404(db, payload.epreuve_id, user)  # accès (abonnement) vérifié
    db.add(EssaiORM(user_id=user.id, epreuve_id=payload.epreuve_id, note=payload.note, duree_s=payload.duree_s))
    db.commit()
    return {"ok": True}


@router.get("/essais")
def historique(db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    rows = (
        db.query(EssaiORM, EpreuveORM)
        .join(EpreuveORM, EpreuveORM.id == EssaiORM.epreuve_id)
        .filter(EssaiORM.user_id == user.id)
        .order_by(EssaiORM.created_at.desc())
        .limit(200)
        .all()
    )
    essais = [{**_label(e), "note": t.note, "duree_s": t.duree_s, "date": t.created_at.isoformat()} for t, e in rows]
    notes: dict[str, list[float]] = {}
    for x in essais:
        if x["note"] is not None:
            notes.setdefault(x["matiere"], []).append(x["note"])
    moyennes = [{"matiere": m, "moyenne": round(sum(v) / len(v), 1), "essais": len(v)} for m, v in sorted(notes.items())]
    return {"essais": essais[:50], "moyennes": moyennes}


@router.get("/revisions")
def a_revoir(db: Session = Depends(get_db), user=Depends(require_user)) -> list[dict]:
    """Épreuves dont la révision est due (échéance ≤ maintenant), les plus en retard d'abord."""
    rows = (
        db.query(EssaiORM, EpreuveORM)
        .join(EpreuveORM, EpreuveORM.id == EssaiORM.epreuve_id)
        .filter(EssaiORM.user_id == user.id, EpreuveORM.statut == "publie")
        .order_by(EssaiORM.created_at.desc())
        .all()
    )
    dernier: dict[str, tuple[EssaiORM, EpreuveORM]] = {}
    nombre: dict[str, int] = {}
    for t, e in rows:  # du plus récent au plus ancien : le premier vu est le dernier essai
        dernier.setdefault(e.id, (t, e))
        nombre[e.id] = nombre.get(e.id, 0) + 1
    maintenant = utc_now()
    dues = []
    for eid, (t, e) in dernier.items():
        echeance = t.created_at + timedelta(days=intervalle_jours(t.note, nombre[eid]))
        if echeance <= maintenant:
            dues.append({**_label(e), "derniere_note": t.note, "retard_jours": (maintenant - echeance).days, "_e": echeance})
    dues.sort(key=lambda d: d["_e"])
    for d in dues:
        del d["_e"]
    return dues[:20]
