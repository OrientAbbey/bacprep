"""Sérialisation des abonnements pour l'affichage (profil, page Abonnement,
activité) — partagé par les routers `subscriptions` et `me` (le helper
vivait dans l'un des deux routers, créant une dépendance router→router).
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..db_models import EpreuveORM, SubscriptionORM
from ..models import SubscriptionOut
from . import store

SCOPE_LABELS = {
    "epreuve": "Épreuve précise",
    "matiere_annee": "Matière, année précise",
    "matiere": "Matière (toutes années)",
    "annee": "Année (toutes matières)",
    "filiere": "Série complète",
}


def scope_of(sub: SubscriptionORM) -> str:
    """Déduit la portée (scope) d'une souscription déjà en base à partir de
    ses champs bruts — l'inverse de `_resolve_scope_fields` (routers/
    subscriptions.py), utilisé pour l'affichage (profil, liste "mine")."""
    if sub.epreuve_id:
        return "epreuve"
    if sub.matiere != "ALL" and sub.annee != "ALL":
        return "matiere_annee"
    if sub.matiere != "ALL":
        return "matiere"
    if sub.annee != "ALL":
        return "annee"
    return "filiere"


def sub_to_out(db: Session, sub: SubscriptionORM) -> SubscriptionOut:
    """Enrichit une souscription brute pour l'affichage : libellé de
    portée lisible, nom de l'épreuve si scope="epreuve", et nombre
    d'épreuves couvertes recalculé en direct (même logique que le
    récapitulatif de la page Abonnement)."""
    scope = scope_of(sub)
    epreuve_label = None
    if sub.epreuve_id:
        e = db.query(EpreuveORM).filter(EpreuveORM.id == sub.epreuve_id).one_or_none()
        if e:
            epreuve_label = f"{e.matiere} — {e.annee}"
    count = store.matching_epreuves_count(
        db,
        classe=None if sub.classe == "ALL" else sub.classe,
        filiere=sub.filiere,
        matiere=None if sub.matiere == "ALL" else sub.matiere,
        annee=None if sub.annee == "ALL" else sub.annee,
        epreuve_id=sub.epreuve_id,
    )
    return SubscriptionOut(
        id=sub.id,
        scope=scope,
        scope_label=SCOPE_LABELS[scope],
        evaluation=sub.evaluation,
        classe=sub.classe,
        filiere=sub.filiere,
        matiere=sub.matiere,
        annee=sub.annee,
        epreuve_id=sub.epreuve_id,
        epreuve_label=epreuve_label,
        epreuves_couvertes=count,
        start_date=sub.start_date,
        end_date=sub.end_date,
        statut=sub.statut,
    )
