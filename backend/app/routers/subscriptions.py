from __future__ import annotations

import hashlib
import hmac
import os
import time
import uuid
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core import referentiel, store
from ..core.config import demo_allowed
from ..core.logging_config import get_logger
from ..core.plans import plan_out, plan_pour, plans_actifs
from ..core.subscriptions import SCOPE_LABELS, subs_to_out
from ..db import get_db, utc_now
from ..db_models import EpreuveORM, PaymentORM, SubscriptionORM
from ..models import CheckoutIn, SubscriptionOut, WebhookIn
from .auth import require_user

router = APIRouter(prefix="/api", tags=["subscriptions"])
log = get_logger("subscriptions")

# Les libellés de portée (SCOPE_LABELS) vivent dans core/subscriptions.py,
# partagés avec le router me (affichage profil) — plus de définition en
# double.

WEBHOOK_MAX_AGE_SECONDS = 300  # anti-replay : notification plus vieille que 5 min rejetée


def _pending_checkout_for(
    db: Session, user, fields: dict, provider: str, montant: int, duree_jours: int
) -> tuple[SubscriptionORM, PaymentORM]:
    """Réutilise un checkout déjà initié pour la MÊME sélection (souscription
    "annulee" + paiement "pending" jamais confirmé), plutôt que d'empiler des
    lignes à chaque rafraîchissement de la page de paiement (revue 2026-09 :
    un simple bouton « payer » re-cliqué ne devait pas gonfler les tables)."""
    subs = (
        db.query(SubscriptionORM)
        .filter(
            SubscriptionORM.user_id == user.id,
            SubscriptionORM.statut == "annulee",
            SubscriptionORM.evaluation == fields["evaluation"],
            SubscriptionORM.classe == fields["classe"],
            SubscriptionORM.filiere == fields["filiere"],
            SubscriptionORM.matiere == fields["matiere"],
            SubscriptionORM.annee == fields["annee"],
            SubscriptionORM.epreuve_id == fields["epreuve_id"],
        )
        .all()
    )
    for s in subs:
        payment = (
            db.query(PaymentORM)
            .filter(PaymentORM.subscription_id == s.id, PaymentORM.statut == "pending")
            .one_or_none()
        )
        # Même sélection ET même formule (montant et durée) : sinon on en crée un nouveau.
        if payment and payment.montant == montant and (s.end_date - s.start_date).days == duree_jours:
            return s, payment
    return _create_checkout(db, user, fields, provider, montant, duree_jours)


def _create_checkout(db: Session, user, fields: dict, provider: str, montant: int, duree_jours: int) -> tuple[SubscriptionORM, PaymentORM]:
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
        end_date=now + timedelta(days=duree_jours),
        statut="annulee",  # devient "active" seulement à confirmation du webhook
    )
    db.add(sub)
    db.flush()

    reference = f"{provider}-{uuid.uuid4().hex}"
    payment = PaymentORM(
        user_id=user.id,
        subscription_id=sub.id,
        provider=provider,
        montant=montant,
        reference_agregateur=reference,
        statut="pending",
    )
    db.add(payment)
    db.flush()
    return sub, payment


def _confirm_payment(db: Session, payment: PaymentORM) -> bool:
    """Active la souscription d'un paiement confirmé (idempotent : un
    rejeu du webhook ne réactive rien de bizarre). Retourne False si le
    paiement était déjà confirmé."""
    if payment.statut == "confirmed":
        log.info("Paiement déjà confirmé (%s) — ignoré (idempotence)", payment.reference_agregateur)
        return False
    payment.statut = "confirmed"
    payment.confirmed_at = utc_now()
    sub = db.query(SubscriptionORM).filter(SubscriptionORM.id == payment.subscription_id).one_or_none()
    if sub:
        sub.statut = "active"
    db.commit()
    log.info("Paiement confirmé: %s — souscription %s activée", payment.reference_agregateur, sub.id if sub else "?")
    return True


def _webhook_secret() -> str:
    secret = os.getenv("PAYMENT_WEBHOOK_SECRET", "").strip()
    if not secret:
        raise HTTPException(503, "Webhook de paiement non configuré (PAYMENT_WEBHOOK_SECRET absent)")
    return secret


def _verify_webhook_signature(payload: WebhookIn) -> bool:
    """HMAC-SHA256 sur le message normalisé ``{provider}|{reference}|{montant}|{timestamp}``
    avec ``PAYMENT_WEBHOOK_SECRET`` (format de signature documenté dans
    PAIEMENT.md — l'algorithme exact de l'agrégateur réel y est re-vérifié
    au moment de l'implémentation)."""
    try:
        expected = hmac.new(
            _webhook_secret().encode("utf-8"),
            f"{payload.provider}|{payload.reference_agregateur}|{payload.montant}|{payload.timestamp}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
    except HTTPException:
        raise
    except Exception as exc:
        log.error("Impossible de calculer la signature attendue: %s", exc)
        return False
    return hmac.compare_digest(expected, payload.signature or "")


@router.get("/pricing")
def pricing(db: Session = Depends(get_db)) -> dict:
    """Formules actives (table `plans`, modifiable depuis l'admin) — endpoint
    public. Les clés `pricing`/`labels`/`descriptions`/`duree_jours` (première
    formule de chaque portée) restent exposées pour compatibilité."""
    plans = plans_actifs(db)
    premiere: dict = {}
    for p in plans:
        premiere.setdefault(p.scope, p)
    return {
        "plans": [plan_out(p) for p in plans],
        "pricing": {k: p.prix for k, p in premiere.items()},
        "labels": {k: p.libelle for k, p in premiere.items()},
        "descriptions": {k: p.description for k, p in premiere.items()},
        "duree_jours": next(iter(premiere.values())).duree_jours if premiere else 365,
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
        return _resolve_epreuve_fields(db, payload)
    return _resolve_classe_fields(payload)


def _resolve_epreuve_fields(db: Session, payload: CheckoutIn) -> dict:
    """Portée « épreuve précise » : filière, classe et évaluation déduites
    de l'épreuve (jamais de sélection manuelle côté acheteur)."""
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


def _resolve_classe_fields(payload: CheckoutIn) -> dict:
    """Portées à cadre de classe (matiere_annee, matiere, annee, filiere) :
    la classe est requise et normalisée, chaque portée impose ses filtres
    et choisit ses jokers "ALL"."""
    if not payload.filiere:
        raise HTTPException(400, "filiere requise")
    classe = referentiel.normalize_classe(payload.classe)
    if not classe:
        raise HTTPException(400, "classe requise : un abonnement est acheté dans le cadre d'une classe")

    if payload.scope == "matiere_annee":
        if not payload.matiere or not payload.annee:
            raise HTTPException(400, "matiere et annee requises")
        matiere, annee = payload.matiere, payload.annee
    elif payload.scope == "matiere":
        if not payload.matiere:
            raise HTTPException(400, "matiere requise")
        matiere, annee = payload.matiere, "ALL"
    elif payload.scope == "annee":
        if not payload.annee:
            raise HTTPException(400, "annee requise")
        matiere, annee = "ALL", payload.annee
    elif payload.scope == "filiere":
        matiere, annee = "ALL", "ALL"
    else:
        raise HTTPException(400, "scope inconnu")

    return {
        "evaluation": "ALL",
        "classe": classe,
        "filiere": payload.filiere,
        "matiere": matiere,
        "annee": annee,
        "epreuve_id": None,
    }


@router.post("/subscriptions/checkout")
def checkout(payload: CheckoutIn, db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """Crée une souscription (statut "annulee" tant que non payée) et un
    paiement simulé "pending" avec une référence unique. La souscription ne
    devient "active" qu'à la confirmation du webhook (voir
    `simulate_webhook`), jamais à l'initiation — voir Module 7 du cahier
    des charges. Refuse (409) si la sélection est déjà accessible."""
    plan = plan_pour(db, payload.scope, payload.plan_id)
    if plan is None:
        raise HTTPException(400, "Formule inconnue ou indisponible")
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

    sub, payment = _pending_checkout_for(db, user, fields, payload.provider, plan.prix, plan.duree_jours)
    db.commit()

    log.info("Checkout créé/réutilisé: sub=%s payment=%s montant=%s classe=%s", sub.id, payment.id, payment.montant, sub.classe)
    return {
        "subscription_id": sub.id,
        "payment_id": payment.id,
        "reference_agregateur": payment.reference_agregateur,
        "montant": payment.montant,
    }


@router.post("/payments/simulate-webhook")
def simulate_webhook(payload: WebhookIn, db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """Simule le webhook de confirmation d'un agrégateur de paiement réel
    (voie DÉMO/développement — voir `payment_webhook` pour la voie réelle
    signée). Idempotent par construction : un paiement déjà confirmé est
    ignoré silencieusement.

    Authentification OBLIGATOIRE (+ vérification que le paiement appartient
    à l'utilisateur) : la référence est retournée au client au checkout —
    un endpoint public l'activant permettrait de s'abonner sans payer.

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

    deja_confirme = not _confirm_payment(db, payment)
    return {"ok": True, "already_confirmed": deja_confirme}


@router.post("/payments/webhook")
def payment_webhook(payload: WebhookIn, db: Session = Depends(get_db)) -> dict:
    """Vrai webhook de confirmation d'un agrégateur (Notch Pay / Monetbil —
    voir PAIEMENT.md) : endpoint PUBLIC car l'authentification repose sur la
    SIGNATURE du contenu, pas sur une session.

    Triple garde :
    - signature HMAC valide (secret ``PAYMENT_WEBHOOK_SECRET``) ;
    - actualité du webhook (``timestamp`` à moins de 5 min — anti-replay) ;
    - montant cohérent avec le paiement stocké.

    Refusé (503) si le secret n'est pas configuré : fail-closed, cohérent
    avec le reste du système (jamais de confirmation de paiement sans
    preuve)."""
    if not demo_allowed() and not os.getenv("PAYMENT_WEBHOOK_SECRET"):
        log.warning("payment_webhook sans PAYMENT_WEBHOOK_SECRET configuré")
        raise HTTPException(503, "Webhook de paiement non configuré")

    if not payload.timestamp or abs(int(time.time()) - payload.timestamp) > WEBHOOK_MAX_AGE_SECONDS:
        raise HTTPException(400, "Notification trop ancienne (timestamp invalide ou rejoué)")

    if not _verify_webhook_signature(payload):
        log.warning("Signature de webhook INVALIDE (%s)", payload.reference_agregateur)
        raise HTTPException(403, "Signature de webhook invalide")

    payment = (
        db.query(PaymentORM)
        .filter(PaymentORM.reference_agregateur == payload.reference_agregateur)
        .one_or_none()
    )
    if not payment:
        raise HTTPException(404, "Paiement introuvable")
    if payload.montant is not None and payload.montant != payment.montant:
        raise HTTPException(400, "Montant incohérent avec le paiement enregistré")

    deja_confirme = not _confirm_payment(db, payment)
    return {"ok": True, "already_confirmed": deja_confirme}


@router.get("/subscriptions/mine", response_model=list[SubscriptionOut])
def my_subscriptions(db: Session = Depends(get_db), user=Depends(require_user)) -> list[SubscriptionOut]:
    """Tous les abonnements de l'utilisateur (actifs, annulés, expirés),
    les plus récents en premier — utilisé par la page Profil."""
    subs = db.query(SubscriptionORM).filter(SubscriptionORM.user_id == user.id).order_by(
        SubscriptionORM.start_date.desc()
    ).all()
    return subs_to_out(db, subs)


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
