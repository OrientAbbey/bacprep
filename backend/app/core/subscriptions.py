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


def subscription_criteria(sub: SubscriptionORM) -> dict:
    """Critère de filtrage d'une souscription sous la forme attendue par
    `store.matching_epreuves_counts` (groupé) — inverse de `sub_to_out`."""
    return {
        "_key": sub.id,
        "classe": sub.classe,
        "filiere": sub.filiere,
        "matiere": sub.matiere,
        "annee": sub.annee,
        "evaluation": sub.evaluation,
        "epreuve_id": sub.epreuve_id,
    }


def sub_to_out(
    db: Session, sub: SubscriptionORM, count: int | None = None
) -> SubscriptionOut:
    """Enrichit une souscription brute pour l'affichage : libellé de
    portée lisible, nom de l'épreuve si scope="epreuve", et nombre
    d'épreuves couvertes recalculé en direct (même logique que le
    récapitulatif de la page Abonnement). `count` est optionnel : quand il
    est fourni (par `subs_to_out`), il évite une requête de comptage par
    abonnement — élimine le N+1 des listes du profil et de la page
    Abonnement."""
    scope = scope_of(sub)
    epreuve_label = None
    if sub.epreuve_id:
        e = db.query(EpreuveORM).filter(EpreuveORM.id == sub.epreuve_id).one_or_none()
        if e:
            epreuve_label = f"{e.matiere} — {e.annee}"
    if count is None:
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


def subs_to_out(db: Session, subs: list[SubscriptionORM]) -> list[SubscriptionOut]:
    """Sérialise TOUTES les souscriptions en UNE requête groupée de comptage
    (`store.matching_epreuves_counts`) puis enrichit chacune avec son compteur
    précalculé — remplace le N+1 de la boucle `[sub_to_out(...) for ...]`
    utilisée par la page Profil (routers/me.py) et la liste "mes
    abonnements" (routers/subscriptions.py), qui faisait une requête SQL de
    comptage par abonnement affiché."""
    out: dict[str, int] = {}
    if subs:
        out = store.matching_epreuves_counts(
            db, [subscription_criteria(s) for s in subs]
        )
    return [
        sub_to_out(db, s, count=out.get(s.id)) for s in subs
    ]
