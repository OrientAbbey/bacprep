from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core import referentiel, store
from ..core.config import demo_allowed
from ..core.logging_config import get_logger
from ..core.subscriptions import SCOPE_LABELS, sub_to_out
from ..db import get_db, utc_now
from ..db_models import EpreuveORM, PaymentORM, SubscriptionORM
from ..models import CheckoutIn, SubscriptionOut, WebhookIn
from .auth import require_user

router = APIRouter(prefix="/api", tags=["subscriptions"])
log = get_logger("subscriptions")

PRICING = {
    "epreuve": 400,
    "matiere_annee": 800,
    "matiere": 2000,
    "annee": 3500,
    "filiere": 6000,
}

# Les libellés de portée (SCOPE_LABELS) vivent dans core/subscriptions.py,
# partagés avec le router me (affichage profil) — plus de définition en
# double.

# Description lisible de ce que débloque chaque portée — affichée sur les
# cartes de prix de la page Abonnement (deux lignes max, phrase simple).
SCOPE_DESCRIPTIONS = {
    "epreuve": "Le sujet et le corrigé d'une seule épreuve, à ton rythme.",
    "matiere_annee": "Toutes les épreuves d'une matière pour une année donnée — idéale pour réviser un chapitre précis.",
    "matiere": "Toutes les années d'une même matière, séquences comme examens — pour creuser une discipline.",
    "annee": "Toutes les matières d'une même année d'examen — pour se mettre en condition comme le jour J.",
    "filiere": "Tout le contenu d'une série pour une classe : chaque matière, chaque année publiée.",
}

DUREE_VALIDITE = timedelta(days=365)


@router.get("/pricing")
def pricing() -> dict:
    """Grille tarifaire par portée d'abonnement (voir Module 6 du cahier
    des charges) — endpoint public, pas besoin d'authentification. Toutes
    les portées (hors « épreuve précise ») sont achetées dans le cadre
    d'une classe."""
    return {
        "pricing": PRICING,
        "labels": SCOPE_LABELS,
        "descriptions": SCOPE_DESCRIPTIONS,
        "duree_jours": DUREE_VALIDITE.days,
    }


@router.get("/subscriptions/deja-couvert")
def deja_couvert(
    scope: str,
    filiere: Optional[str] = None,
    matiere: Optional[str] = None,
    annee: Optional[str] = None,
    classe: Optional[str] = None,
    epreuve_id: Optional[str] = None,
    db: Session = Depends(get_db),
    user=Depends(require_user),
) -> dict:
    """Indique si la sélection courante sur la page Abonnement est déjà
    couverte (épreuve gratuite, ou abonnement actif existant qui la
    recouvre déjà) — permet au frontend de masquer le moyen de paiement et
    d'afficher un message explicite plutôt que de proposer un paiement
    pour un contenu déjà accessible."""
    covered = store.scope_already_covered(
        db,
        user.id,
        scope,
        filiere=filiere,
        matiere=matiere,
        annee=annee,
        classe=classe,
        epreuve_id=epreuve_id,
    )
    return {"deja_couvert": covered}


def _resolve_scope_fields(db: Session, payload: CheckoutIn) -> dict:
    """Traduit la portée choisie (scope) + les filtres fournis en champs
    concrets `{evaluation, classe, filiere, matiere, annee, epreuve_id}` à
    stocker sur la souscription, avec "ALL" comme joker pour matiere/annee
    selon la portée (voir le tableau des 5 portées dans le cahier des
    charges, Module 6).

    Depuis la refonte multi-classes, un abonnement (hors "epreuve") est
    TOUJOURS acheté dans le cadre d'une classe (`classe` requise) — le
    frontend transmet la classe du contexte de navigation. Pour
    scope="epreuve", filière/classe/évaluation sont déduites de l'épreuve
    elle-même plutôt que redemandées à l'utilisateur."""
    if payload.scope == "epreuve":
        if not payload.epreuve_id:
            raise HTTPException(400, "epreuve_id requis pour ce type d'abonnement")
        e = db.query(EpreuveORM).filter(EpreuveORM.id == payload.epreuve_id).one_or_none()
        if not e:
            raise HTTPException(404, "Épreuve introuvable")
        if not e.filieres:
            raise HTTPException(400, "Cette épreuve n'a aucune série associée")
        return {
            "evaluation": e.evaluation,
            "classe": e.classe,
            "filiere": e.filieres[0],
            "matiere": "ALL",
            "annee": "ALL",
            "epreuve_id": e.id,
        }

    if not payload.filiere:
        raise HTTPException(400, "filiere requise")
    classe = referentiel.normalize_classe(payload.classe)
    if not classe:
        raise HTTPException(400, "classe requise : un abonnement est acheté dans le cadre d'une classe")

    if payload.scope == "matiere_annee":
        if not payload.matiere or not payload.annee:
            raise HTTPException(400, "matiere et annee requises")
        return {
            "evaluation": "ALL",
            "classe": classe,
            "filiere": payload.filiere,
            "matiere": payload.matiere,
            "annee": payload.annee,
            "epreuve_id": None,
        }
    if payload.scope == "matiere":
        if not payload.matiere:
            raise HTTPException(400, "matiere requise")
        return {
            "evaluation": "ALL",
            "classe": classe,
            "filiere": payload.filiere,
            "matiere": payload.matiere,
            "annee": "ALL",
            "epreuve_id": None,
        }
    if payload.scope == "annee":
        if not payload.annee:
            raise HTTPException(400, "annee requise")
        return {
            "evaluation": "ALL",
            "classe": classe,
            "filiere": payload.filiere,
            "matiere": "ALL",
            "annee": payload.annee,
            "epreuve_id": None,
        }
    if payload.scope == "filiere":
        return {
            "evaluation": "ALL",
            "classe": classe,
            "filiere": payload.filiere,
            "matiere": "ALL",
            "annee": "ALL",
            "epreuve_id": None,
        }

    raise HTTPException(400, "scope inconnu")


@router.post("/subscriptions/checkout")
def checkout(payload: CheckoutIn, db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """Crée une souscription (statut "annulee" tant que non payée) et un
    paiement simulé "pending" avec une référence unique. La souscription ne
    devient "active" qu'à la confirmation du webhook (voir
    `simulate_webhook`), jamais à l'initiation — voir Module 7 du cahier
    des charges. Refuse (409) si la sélection est déjà accessible."""
    if payload.scope not in PRICING:
        raise HTTPException(400, "scope inconnu")
    fields = _resolve_scope_fields(db, payload)

    # Garde-fou côté serveur (en plus du masquage côté frontend) : on ne
    # crée jamais un paiement pour une sélection déjà couverte (épreuve
    # gratuite, ou abonnement actif existant qui la recouvre déjà) — évite
    # qu'un appel direct à l'API contourne le message d'interface.
    if store.scope_already_covered(
        db,
        user.id,
        payload.scope,
        filiere=fields["filiere"] if payload.scope != "epreuve" else None,
        matiere=None if fields["matiere"] == "ALL" else fields["matiere"],
        annee=None if fields["annee"] == "ALL" else fields["annee"],
        classe=None if payload.scope == "epreuve" else fields["classe"],
        epreuve_id=fields["epreuve_id"],
    ):
        raise HTTPException(409, "Cette sélection est déjà accessible (gratuite ou déjà abonnée)")

    now = utc_now()
    sub = SubscriptionORM(
        user_id=user.id,
        evaluation=fields["evaluation"],
        classe=fields["classe"],
        filiere=fields["filiere"],
        matiere=fields["matiere"],
        annee=fields["annee"],
        epreuve_id=fields["epreuve_id"],
        start_date=now,
        end_date=now + DUREE_VALIDITE,
        statut="annulee",  # devient "active" seulement à confirmation du webhook
    )
    db.add(sub)
    db.flush()

    montant = PRICING[payload.scope]
    reference = f"SIMULATED-{uuid.uuid4().hex}"
    payment = PaymentORM(
        user_id=user.id,
        subscription_id=sub.id,
        provider=payload.provider,
        montant=montant,
        reference_agregateur=reference,
        statut="pending",
    )
    db.add(payment)
    db.commit()

    log.info("Checkout créé: sub=%s payment=%s montant=%s classe=%s", sub.id, payment.id, montant, sub.classe)
    return {
        "subscription_id": sub.id,
        "payment_id": payment.id,
        "reference_agregateur": reference,
        "montant": montant,
    }


@router.post("/payments/simulate-webhook")
def simulate_webhook(payload: WebhookIn, db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """Simule le webhook de confirmation d'un agrégateur de paiement réel
    (Notch Pay/Monetbil — voir PAIEMENT.md pour l'intégration réelle).
    Idempotent par construction : si le paiement est déjà "confirmed", la
    notification est ignorée silencieusement plutôt que de réactiver ou
    re-traiter la souscription (l'agrégateur peut notifier plusieurs fois
    le même événement).

    Authentification OBLIGATOIRE (+ vérification que le paiement appartient
    à l'utilisateur) : la référence est retournée au client au checkout —
    un endpoint public l'activant permettrait de s'abonner sans payer. Un
    vrai agrégateur signera ses notifications (HMAC + timestamp) ; le
    contrôle d'appartenance sera remplacé par la vérification de signature.

    REFUSÉ en production (ENV=prod) sauf DEMO_MODE=true explicite : même
    authentifié, l'utilisateur connaît la référence (reçue au checkout) et
    pourrait donc s'activer un abonnement gratuitement."""
    if not demo_allowed():
        log.warning("simulate-webhook refusé en production sans DEMO_MODE")
        raise HTTPException(403, "Simulation de paiement désactivée en production")
    payment = (
        db.query(PaymentORM)
        .filter(
            PaymentORM.reference_agregateur == payload.reference_agregateur,
            PaymentORM.user_id == user.id,
        )
        .one_or_none()
    )
    if not payment:
        raise HTTPException(404, "Paiement introuvable")

    if payment.statut == "confirmed":
        log.info("Webhook rejoué pour %s — ignoré (idempotence)", payload.reference_agregateur)
        return {"ok": True, "already_confirmed": True}

    payment.statut = "confirmed"
    payment.confirmed_at = utc_now()

    sub = db.query(SubscriptionORM).filter(SubscriptionORM.id == payment.subscription_id).one_or_none()
    if sub:
        sub.statut = "active"

    db.commit()
    log.info("Paiement confirmé: %s — souscription %s activée", payload.reference_agregateur, sub.id if sub else "?")
    return {"ok": True, "already_confirmed": False}


@router.get("/subscriptions/mine", response_model=list[SubscriptionOut])
def my_subscriptions(db: Session = Depends(get_db), user=Depends(require_user)) -> list[SubscriptionOut]:
    """Tous les abonnements de l'utilisateur (actifs, annulés, expirés),
    les plus récents en premier — utilisé par la page Profil."""
    subs = db.query(SubscriptionORM).filter(SubscriptionORM.user_id == user.id).order_by(
        SubscriptionORM.start_date.desc()
    ).all()
    return [sub_to_out(db, s) for s in subs]


@router.post("/subscriptions/{sub_id}/cancel")
def cancel_subscription(sub_id: str, db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """Annule immédiatement un abonnement (statut -> "annulee", jamais
    supprimé physiquement — préserve l'historique de paiement pour le
    total dépensé affiché au profil). Pas de remboursement au prorata dans
    ce prototype."""
    sub = db.query(SubscriptionORM).filter(SubscriptionORM.id == sub_id).one_or_none()
    if not sub or sub.user_id != user.id:
        raise HTTPException(404, "Abonnement introuvable")
    sub.statut = "annulee"
    db.commit()
    log.info("Abonnement %s annulé par %s", sub_id, user.email)
    return {"ok": True}
