from __future__ import annotations

import hashlib
import json
import uuid
from datetime import timedelta
from typing import Optional

from fastapi import WebSocket
from sqlalchemy.orm import Session

from ..db import utc_now
from ..db_models import (
    AIConversationORM,
    ConsultationORM,
    EpreuveFiliereORM,
    EpreuveORM,
    KickoutNoticeORM,
    SessionORM,
    SubscriptionORM,
    UserORM,
)
from .logging_config import get_logger

log = get_logger("store")

MAX_CONVERSATIONS_PAR_EPREUVE = 5
MAX_HISTORIQUE = 10

# Durées de vie d'une session élève (revue sécurité 2026-09 : 30 jours
# pleins était excessif — un token volé restait actif un mois) :
# - 7 jours GLISSANTS : chaque activité repousse l'expiration (`last_seen`,
#   rafraîchi avec un granularity d'1 h pour limiter les écritures) ;
# - 14 jours MAXIMUM ABSOLU depuis l'émission, quelle que soit l'activité —
#   au-delà, reconnexion obligatoire.
SESSION_TTL_GLISSANT = timedelta(days=7)
SESSION_TTL_MAX = timedelta(days=14)
# Ne pas réécrire `last_seen` à CHAQUE requête : granularité du rafraîchissement.
SESSION_REFRESH_GRANULARITE = timedelta(hours=1)

# Registre en mémoire des connexions WebSocket actives : user_id -> [WebSocket].
# Une liste par utilisateur : plusieurs onglets peuvent être ouverts, le
# kick-out doit tous les toucher (pas seulement le plus récent).
ACTIVE_WEBSOCKETS: dict[str, list[WebSocket]] = {}


# ---------- Utilisateurs & sessions ----------

def get_or_create_user(db: Session, email: str, nom: str) -> UserORM:
    """Retrouve l'utilisateur par email, ou le crée au premier login (nom
    mis à jour si fourni et différent). Le consentement n'est PAS posé à la
    création : il est recueilli explicitement à la connexion via la modale
    dédiée (`PUT /api/me/consentement`) — consent_ia/consent_notes restent
    NULL (« pas encore demandé ») tant que l'élève n'a pas choisi."""
    user = db.query(UserORM).filter(UserORM.email == email).one_or_none()
    if user:
        if nom and user.nom != nom:
            user.nom = nom
            db.commit()
        return user
    user = UserORM(email=email, nom=nom)
    db.add(user)
    db.commit()
    db.refresh(user)
    log.info("Nouvel utilisateur créé: %s", email)
    return user


def _hash_token(token: str) -> str:
    """Empreinte SHA-256 d'un jeton de session : la base ne stocke que le
    hash, une fuite de la table ne permet pas de rejouer les sessions."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def create_session(db: Session, user_id: str, platform: str) -> str:
    """Crée une nouvelle session, invalide l'ancienne et retourne le token.

    Le message de kick-out est poussé *avant* la suppression effective de
    l'ancienne session (via WebSocket), pour garantir sa livraison même si
    l'ancien appareil perd immédiatement l'accès à l'API (voir
    CAHIER_DES_CHARGES, Module 1). Seul le hash du jeton part en base."""
    existing = db.query(SessionORM).filter(SessionORM.user_id == user_id).one_or_none()
    if existing:
        await notify_kickout(db, user_id, "Votre session a été fermée car vous vous êtes connecté ailleurs.")
        db.delete(existing)
        db.flush()

    token = uuid.uuid4().hex
    db.add(SessionORM(user_id=user_id, token=_hash_token(token), platform=platform, issued_at=utc_now()))
    db.commit()
    log.info("Session créée pour user_id=%s (platform=%s)", user_id, platform)
    return token


def resolve_session(db: Session, token: str) -> Optional[UserORM]:
    """Retrouve l'utilisateur associé à un jeton de session, ou None si le
    jeton est absent/invalide/expiré. Double expiration :
    - GLISSANTE : plus de `SESSION_TTL_GLISSANT` (7 j) sans activité
      (`last_seen`) — un compte inactif est déconnecté ;
    - MAXIMALE : plus de `SESSION_TTL_MAX` (14 j) depuis l'émission, même
      avec de l'activité — un jeton ne vit jamais plus de deux semaines.
    Une session périmée est purgée ; la session d'un compte BANNI est
    immédiatement supprimée (le kick-out WebSocket ayant déjà été poussé
    par la route d'admin qui a posé le ban)."""
    if not token:
        return None
    sess = db.query(SessionORM).filter(SessionORM.token == _hash_token(token)).one_or_none()
    if not sess:
        return None
    now = utc_now()
    emis_since = now - (sess.issued_at or now)
    inactif_since = now - (sess.last_seen or sess.issued_at or now)
    if emis_since > SESSION_TTL_MAX or inactif_since > SESSION_TTL_GLISSANT:
        raison = "durée maximale atteinte" if emis_since > SESSION_TTL_MAX else "inactivité"
        log.info("Session purgée pour user_id=%s (%s)", sess.user_id, raison)
        db.delete(sess)
        db.commit()
        return None
    # Expiration glissante : rafraîchit `last_seen` (granularité 1 h pour
    # éviter une écriture par requête).
    if inactif_since > SESSION_REFRESH_GRANULARITE:
        sess.last_seen = now
        db.commit()
    user = db.query(UserORM).filter(UserORM.id == sess.user_id).one_or_none()
    if user is not None and user.banni:
        db.delete(sess)
        db.commit()
        log.info("Session d'un compte banni supprimée: user_id=%s", user.id)
        return None
    return user


def end_session(db: Session, token: str) -> None:
    """Supprime la session correspondant à ce jeton (déconnexion explicite)."""
    sess = db.query(SessionORM).filter(SessionORM.token == _hash_token(token)).one_or_none()
    if sess:
        db.delete(sess)
        db.commit()


def pop_kickout_notice(db: Session, user_id: str) -> Optional[str]:
    """Lit puis supprime la notification de kick-out en attente pour cet
    utilisateur (filet de secours historique par sondage, voir
    `GET /api/auth/kickout-notice/{user_id}` — le mécanisme principal est
    désormais le push WebSocket, voir `notify_kickout`)."""
    notice = db.query(KickoutNoticeORM).filter(KickoutNoticeORM.user_id == user_id).one_or_none()
    if not notice:
        return None
    message = notice.message
    db.delete(notice)
    db.commit()
    return message


async def notify_kickout(db: Session, user_id: str, message: str) -> None:
    """Pousse un message de kick-out en temps réel via WebSocket si une
    connexion est active pour cet utilisateur. Persiste également la
    notification dans `kickout_notices` comme filet de secours pour le
    endpoint de sondage historique (`GET /auth/kickout-notice/{user_id}`),
    conservé mais plus interrogé en continu par le frontend (v2.0)."""
    ws_conns = ACTIVE_WEBSOCKETS.get(user_id) or []
    for ws in ws_conns:
        try:
            await ws.send_json({"type": "kicked_out", "message": message})
            log.info("Kick-out poussé en temps réel (WebSocket) à user_id=%s", user_id)
        except Exception as exc:  # connexion déjà morte, on retombe sur le filet de secours
            log.warning("Échec d'envoi WebSocket kick-out pour user_id=%s: %s", user_id, exc)

    existing = db.query(KickoutNoticeORM).filter(KickoutNoticeORM.user_id == user_id).one_or_none()
    if existing:
        existing.message = message
    else:
        db.add(KickoutNoticeORM(user_id=user_id, message=message))
    db.flush()


# ---------- Accès ----------

def is_gratuit(epreuve: EpreuveORM) -> bool:
    """Une épreuve marquée gratuite contourne toute vérification
    d'abonnement (contenu de découverte, voir Module 6)."""
    return bool(epreuve.gratuit)


def covered_epreuves_condition(db: Session, user_id: str):
    """SOURCE UNIQUE de la règle de couverture d'abonnement, sous forme
    d'expression SQLAlchemy : un abonnement actif (non expiré) de
    `user_id` couvre une épreuve quand :

    - il cible exactement cette épreuve (`epreuve_id`), OU
    - portée large : évaluation/classe/matière/année correspondent (ou
      joker "ALL") ET sa série fait partie des séries de l'épreuve
      (appartenance, pas égalité stricte).

    Dérivent de cette expression : `has_access` (EXISTS), le filtre
    « ouvert » du catalogue (epreuves.py) — toute évolution du paywall se
    fait ICI uniquement, jamais en miroir ailleurs."""
    now = utc_now()
    return (
        (SubscriptionORM.user_id == user_id)
        & (SubscriptionORM.statut == "active")
        & (SubscriptionORM.end_date >= now)
        & (
            # Abonnement « épreuve précise » : couvre UNIQUEMENT cette
            # épreuve — jamais les autres épreuves de la même classe/série
            # (les champs evaluation/classe/filière stockés pour l'affichage
            # ne doivent pas élargir la couverture).
            (SubscriptionORM.epreuve_id.isnot(None)) & (SubscriptionORM.epreuve_id == EpreuveORM.id)
            | (
                (SubscriptionORM.epreuve_id.is_(None))
                & ((SubscriptionORM.evaluation == "ALL") | (SubscriptionORM.evaluation == EpreuveORM.evaluation))
                & ((SubscriptionORM.classe == "ALL") | (SubscriptionORM.classe == EpreuveORM.classe))
                & ((SubscriptionORM.matiere == "ALL") | (SubscriptionORM.matiere == EpreuveORM.matiere))
                & ((SubscriptionORM.annee == "ALL") | (SubscriptionORM.annee == EpreuveORM.annee))
                & (
                    db.query(EpreuveFiliereORM.epreuve_id)
                    .filter(
                        EpreuveFiliereORM.epreuve_id == EpreuveORM.id,
                        EpreuveFiliereORM.filiere == SubscriptionORM.filiere,
                    )
                    .exists()
                )
            )
        )
    )


def has_access(db: Session, user_id: str, epreuve: EpreuveORM) -> bool:
    """Vrai si l'épreuve est gratuite, ou si l'utilisateur a un abonnement
    actif la couvrant (règle définie par `covered_epreuves_condition`)."""
    if is_gratuit(epreuve):
        return True
    covered = (
        db.query(EpreuveORM.id)
        .filter(EpreuveORM.id == epreuve.id, covered_epreuves_condition(db, user_id))
        .first()
    )
    return covered is not None


def matching_epreuves_count(
    db: Session,
    evaluation: Optional[str] = None,
    classe: Optional[str] = None,
    filiere: Optional[str] = None,
    matiere: Optional[str] = None,
    annee: Optional[str] = None,
    epreuve_id: Optional[str] = None,
) -> int:
    """Nombre d'épreuves publiées correspondant à une combinaison de
    filtres — sert à la fois au récapitulatif d'abonnement et à
    l'enrichissement des souscriptions affichées au profil. Les compteurs
    sont calculés dans le cadre d'une classe (le `classe` d'un abonnement
    ne vaut jamais "ALL" pour les scopes achetés depuis la refonte)."""
    query = db.query(EpreuveORM).filter(EpreuveORM.statut == "publie")
    if evaluation:
        query = query.filter(EpreuveORM.evaluation == evaluation)
    if classe:
        query = query.filter(EpreuveORM.classe == classe)
    if filiere:
        query = query.join(EpreuveFiliereORM, EpreuveFiliereORM.epreuve_id == EpreuveORM.id).filter(
            EpreuveFiliereORM.filiere == filiere
        )
    if matiere:
        query = query.filter(EpreuveORM.matiere == matiere)
    if annee:
        query = query.filter(EpreuveORM.annee == annee)
    if epreuve_id:
        query = query.filter(EpreuveORM.id == epreuve_id)
    return query.distinct().count()


def matching_epreuves_counts(
    db: Session, criteria: list[dict]
) -> dict[str, int]:
    """Compteurs couverts par CHAQUE souscription en UNE requête groupée —
    remplace le N+1 de `sub_to_out` (core/subscriptions.py) qui faisait une
    requête SQL de comptage par abonnement affiché au profil (2 appels : me.py
    et subscriptions.py). Charge TOUTES les épreuves publiées et leurs
    filières en un seul passage, puis applique en mémoire exactement les
    mêmes règles que `matching_epreuves_count` — même source de vérité, aucune
    dérive entre le chemin unitaire et le chemin groupé.

    `criteria` : listes de dictionnaires {classe, filiere, matiere, annee,
    epreuve_id} (les jokers "ALL" déjà résolus par l'appelant : `sub_to_out`
    ne passe jamais matiere/annee sans valeur ou "ALL" mélangé)."""
    epreuves: dict[str, tuple[str, str, str, str]] = {}
    filieres: dict[str, set[str]] = {}
    for eid, evaluation, classe, matiere, annee in (
        db.query(
            EpreuveORM.id,
            EpreuveORM.evaluation,
            EpreuveORM.classe,
            EpreuveORM.matiere,
            EpreuveORM.annee,
        )
        .filter(EpreuveORM.statut == "publie")
        .all()
    ):
        epreuves[eid] = (evaluation, classe, matiere, annee)
        filieres[eid] = set()
    for eid, filiere in (
        db.query(EpreuveFiliereORM.epreuve_id, EpreuveFiliereORM.filiere).all()
    ):
        if eid in epreuves:
            filieres[eid].add(filiere)

    out: dict[str, int] = {}
    for crit in criteria:
        count = 0
        for eid, (evaluation, classe, matiere, annee) in epreuves.items():
            if crit["epreuve_id"] and crit["epreuve_id"] != eid:
                continue
            if crit["evaluation"] and crit["evaluation"] != "ALL" and crit["evaluation"] != evaluation:
                continue
            if crit["classe"] and crit["classe"] != "ALL" and crit["classe"] != classe:
                continue
            if crit["matiere"] and crit["matiere"] != "ALL" and crit["matiere"] != matiere:
                continue
            if crit["annee"] and crit["annee"] != "ALL" and crit["annee"] != annee:
                continue
            f = crit.get("filiere")
            if f and f != "ALL" and f not in filieres[eid]:
                continue
            count += 1
        out[crit["_key"]] = count
    return out


def scope_already_covered(
    db: Session,
    user_id: str,
    scope: str,
    filiere: Optional[str] = None,
    matiere: Optional[str] = None,
    annee: Optional[str] = None,
    classe: Optional[str] = None,
    epreuve_id: Optional[str] = None,
) -> bool:
    """Détermine si la sélection en cours sur la page Abonnement est déjà
    entièrement satisfaite — soit parce que l'épreuve visée est gratuite,
    soit parce qu'un abonnement actif de l'utilisateur la couvre déjà.

    Sert à éviter de proposer un paiement pour un contenu déjà accessible
    (bug remonté : les épreuves gratuites ou déjà couvertes déclenchaient
    quand même le flux de paiement sur la page Abonnement).

    Pour scope="epreuve", réutilise directement `has_access` (déjà testé,
    gère le cas gratuit ET le cas abonné). Pour les portées plus larges
    (matiere_annee/matiere/annee/filiere), cherche un abonnement actif dont
    la portée couvre déjà — au sens large, wildcard "ALL" compris — la
    sélection demandée.
    """
    if scope == "epreuve":
        if not epreuve_id:
            return False
        epreuve = db.query(EpreuveORM).filter(EpreuveORM.id == epreuve_id).one_or_none()
        if not epreuve:
            return False
        return has_access(db, user_id, epreuve)

    if not filiere or not classe:
        return False

    now = utc_now()
    subs = (
        db.query(SubscriptionORM)
        .filter(
            SubscriptionORM.user_id == user_id,
            SubscriptionORM.statut == "active",
            SubscriptionORM.end_date >= now,
        )
        .all()
    )
    for sub in subs:
        # Un abonnement "epreuve" précise (epreuve_id posé) ne couvre QUE cette
        # épreuve — on ne le compte pas pour une portée large, même s'il stocke
        # matiere=ALL/annee=ALL (la couverture d'une épreuve précise est dérivée
        # de l'epreuve_id dans has_access, pas des jokers).
        if sub.epreuve_id:
            continue
        if sub.classe not in ("ALL", classe) or sub.filiere != filiere:
            continue
        # Quand la sélection NE CONTRAINT PAS une dimension (matiere/annee
        # absents), un abonnement ne la couvre que s'il la couvre LARGEMENT
        # ("ALL") : exiger le joker évite qu'un abonnement étroit (une seule
        # matière, une seule année) soit considéré comme couvrant une portée
        # PLUS large — bug corrigé 2026-09 qui bloquait à jamais le passage
        # de "matiere" à "annee"/"filiere".
        if not matiere and sub.matiere != "ALL":
            continue
        if not annee and sub.annee != "ALL":
            continue
        if matiere and sub.matiere != "ALL" and sub.matiere != matiere:
            continue
        if annee and sub.annee != "ALL" and sub.annee != annee:
            continue
        return True
    return False


# ---------- Historique de consultation ----------

def record_consultation(db: Session, user_id: str, epreuve_id: str) -> None:
    """Enregistre/rafraîchit l'horodatage de consultation d'une épreuve —
    une ligne par (utilisateur, épreuve), mise à jour plutôt que dupliquée
    à chaque nouvelle visite (évite une croissance illimitée de la table)."""
    row = (
        db.query(ConsultationORM)
        .filter(ConsultationORM.user_id == user_id, ConsultationORM.epreuve_id == epreuve_id)
        .one_or_none()
    )
    if row:
        row.consulted_at = utc_now()
    else:
        db.add(ConsultationORM(user_id=user_id, epreuve_id=epreuve_id, consulted_at=utc_now()))
    db.commit()


def get_recent_consultations(db: Session, user_id: str, limit: int = MAX_HISTORIQUE) -> list[ConsultationORM]:
    """Les `limit` épreuves consultées les plus récemment par cet
    utilisateur, triées décroissant — le plafond est appliqué à la
    lecture, jamais par suppression physique des entrées plus anciennes."""
    return (
        db.query(ConsultationORM)
        .filter(ConsultationORM.user_id == user_id)
        .order_by(ConsultationORM.consulted_at.desc())
        .limit(limit)
        .all()
    )


# ---------- Conversations IA ----------

def list_conversations(db: Session, user_id: str, epreuve_id: str) -> list[AIConversationORM]:
    """Toutes les discussions (onglets) de cet utilisateur sur cette
    épreuve, par ordre de création."""
    return (
        db.query(AIConversationORM)
        .filter(AIConversationORM.user_id == user_id, AIConversationORM.epreuve_id == epreuve_id)
        .order_by(AIConversationORM.created_at.asc())
        .all()
    )


def create_conversation(
    db: Session, user_id: str, epreuve_id: str, contexte: str, label: str
) -> AIConversationORM:
    """Crée une nouvelle discussion — lève ValueError si le plafond de 5
    discussions actives par (utilisateur, épreuve) est déjà atteint
    (l'appelant traduit ceci en 409)."""
    count = (
        db.query(AIConversationORM)
        .filter(AIConversationORM.user_id == user_id, AIConversationORM.epreuve_id == epreuve_id)
        .count()
    )
    if count >= MAX_CONVERSATIONS_PAR_EPREUVE:
        raise ValueError("Limite de conversations atteinte pour cette épreuve")
    conv = AIConversationORM(
        user_id=user_id,
        epreuve_id=epreuve_id,
        label=label,
        contexte=contexte,
        messages_json="[]",
    )
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return conv


def update_conversation(
    db: Session,
    conv: AIConversationORM,
    messages: list[dict],
    label: Optional[str] = None,
    contexte: Optional[str] = None,
) -> AIConversationORM:
    """Remplace intégralement les messages d'une discussion (et son
    libellé si fourni), sérialisés en JSON. Si `contexte` est fourni,
    remplace aussi le passage/contenu servant de contexte à l'assistant —
    utilisé quand l'élève sélectionne un nouveau passage alors que le
    panneau assistant est déjà ouvert sur une discussion en cours (le
    nouveau passage devient le contexte actif de cette discussion, plutôt
    que d'ouvrir une nouvelle discussion à chaque sélection)."""
    conv.messages_json = json.dumps(messages, ensure_ascii=False)
    if label:
        conv.label = label
    if contexte is not None:
        conv.contexte = contexte
    conv.updated_at = utc_now()
    db.commit()
    db.refresh(conv)
    return conv


def delete_conversation(db: Session, conv: AIConversationORM) -> None:
    """Ferme (supprime) une discussion — libère une place dans le plafond
    de 5 discussions actives par épreuve."""
    db.delete(conv)
    db.commit()


def conversation_to_dict(conv: AIConversationORM) -> dict:
    """Sérialise une discussion ORM (désérialise messages_json) pour la
    réponse API `ConversationOut`."""
    return {
        "id": conv.id,
        "epreuve_id": conv.epreuve_id,
        "label": conv.label,
        "contexte": conv.contexte,
        "messages": json.loads(conv.messages_json or "[]"),
        "created_at": conv.created_at,
        "updated_at": conv.updated_at,
    }
