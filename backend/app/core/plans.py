"""Formules d'abonnement : valeurs initiales et accès (table `plans`)."""
from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from ..db_models import PlanORM
from .subscriptions import SCOPE_LABELS

# Valeurs initiales : insérées UNE fois, quand la table est vide.
_DEFAUTS = {
    "epreuve": (400, "Le sujet et le corrigé d'une seule épreuve, à ton rythme.", "Subject and correction of a single paper, at your own pace."),
    "matiere_annee": (800, "Toutes les épreuves d'une matière pour une année donnée — idéale pour réviser un chapitre précis.", "All papers of one subject for a given year."),
    "matiere": (2000, "Toutes les années d'une même matière, séquences comme examens — pour creuser une discipline.", "All years of one subject, to dig deeper."),
    "annee": (3500, "Toutes les matières d'une même année d'examen — pour se mettre en condition comme le jour J.", "All subjects of one exam year, exam-day conditions."),
    "filiere": (6000, "Tout le contenu d'une série pour une classe : chaque matière, chaque année publiée.", "Everything for a stream and class: every subject, every published year."),
}
_LIBELLES_EN = {
    "epreuve": "Single paper",
    "matiere_annee": "Subject, one year",
    "matiere": "Subject (all years)",
    "annee": "Year (all subjects)",
    "filiere": "Full stream",
}


def seed_plans(db: Session) -> None:
    if db.query(PlanORM.id).first():
        return
    for i, (scope, (prix, desc, desc_en)) in enumerate(_DEFAUTS.items()):
        db.add(PlanORM(scope=scope, libelle=SCOPE_LABELS[scope], libelle_en=_LIBELLES_EN[scope],
                       description=desc, description_en=desc_en, prix=prix, duree_jours=365, ordre=i))
    db.commit()


def plans_actifs(db: Session) -> list[PlanORM]:
    return db.query(PlanORM).filter(PlanORM.actif.is_(True)).order_by(PlanORM.ordre, PlanORM.prix).all()


def plan_pour(db: Session, scope: str, plan_id: Optional[str]) -> Optional[PlanORM]:
    """Formule demandée (par id) ou, à défaut, la première formule active du scope."""
    q = db.query(PlanORM).filter(PlanORM.actif.is_(True), PlanORM.scope == scope)
    if plan_id:
        return q.filter(PlanORM.id == plan_id).one_or_none()
    return q.order_by(PlanORM.ordre, PlanORM.prix).first()


def plan_out(p: PlanORM) -> dict:
    return {c.name: getattr(p, c.name) for c in PlanORM.__table__.columns}
