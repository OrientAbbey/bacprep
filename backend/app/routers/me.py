from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..core import store
from ..db import get_db
from ..db_models import EpreuveORM, PaymentORM
from .auth import require_user
from .subscriptions import _sub_to_out
from ..db_models import SubscriptionORM

router = APIRouter(prefix="/api/me", tags=["me"])


@router.get("/profil")
def profil(db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """Page Profil : identité, abonnements actifs enrichis (portée
    lisible, épreuves couvertes, dates) et total dépensé (calculé sur les
    paiements confirmés, donc toujours exact même après annulation d'un
    abonnement — voir Module 10 du cahier des charges)."""
    subs = (
        db.query(SubscriptionORM)
        .filter(SubscriptionORM.user_id == user.id, SubscriptionORM.statut == "active")
        .order_by(SubscriptionORM.start_date.desc())
        .all()
    )
    total_depense = sum(
        p.montant
        for p in db.query(PaymentORM).filter(PaymentORM.user_id == user.id, PaymentORM.statut == "confirmed").all()
    )
    return {
        "email": user.email,
        "nom": user.nom,
        "membre_depuis": user.created_at,
        "abonnements": [_sub_to_out(db, s).model_dump() for s in subs],
        "total_depense_fcfa": total_depense,
    }


@router.get("/historique")
def historique(db: Session = Depends(get_db), user=Depends(require_user)) -> list[dict]:
    """Les 10 dernières épreuves consultées par l'utilisateur (plus
    récentes en premier), affichées en tête du catalogue."""
    consultations = store.get_recent_consultations(db, user.id)
    out = []
    for c in consultations:
        e = db.query(EpreuveORM).filter(EpreuveORM.id == c.epreuve_id).one_or_none()
        if not e:
            continue
        out.append(
            {
                "epreuve_id": e.id,
                "matiere": e.matiere,
                "annee": e.annee,
                "classe": e.classe,
                "evaluation": e.evaluation,
                "filieres": e.filieres,
                "consulted_at": c.consulted_at,
            }
        )
    return out
