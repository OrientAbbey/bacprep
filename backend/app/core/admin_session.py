from __future__ import annotations

import hashlib
import hmac
import os
import uuid
from datetime import timedelta
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import utc_now
from ..db_models import AdminLockORM, UserORM
from .logging_config import get_logger

log = get_logger("admin_session")

# Défaut de la fenêtre d'inactivité admin : 3 minutes. Paramétrable via
# ADMIN_SESSION_TIMEOUT_MINUTES (lu dynamiquement — un redémarrage du
# backend suffit à l'appliquer, ou via l'env du process de service).
ADMIN_SESSION_TIMEOUT_DEFAULT_MINUTES = 3
# Plafond ABSOLU de durée de session, indépendants de l'activité. Sans lui,
# la fenêtre d'inactivité glisse à chaque requête et le heartbeat la
# renouvelle : un jeton volé se maintient en vie indéfiniment. 8 h par défaut.
ADMIN_SESSION_MAX_DEFAULT_MINUTES = 480
LOCK_ID = "singleton"


def session_max_duration() -> timedelta:
    """Durée maximale d'une session admin, activité ou non."""
    raw = os.getenv("ADMIN_SESSION_MAX_MINUTES", "").strip()
    try:
        minutes = float(raw) if raw else ADMIN_SESSION_MAX_DEFAULT_MINUTES
    except ValueError:
        log.warning(
            "ADMIN_SESSION_MAX_MINUTES invalide (%r) — défaut %s min utilisé",
            raw,
            ADMIN_SESSION_MAX_DEFAULT_MINUTES,
        )
        minutes = ADMIN_SESSION_MAX_DEFAULT_MINUTES
    return timedelta(minutes=max(1.0, minutes))


def _hash_token(token: str) -> str:
    """Empreinte SHA-256 du jeton admin.

    La colonne ``admin_lock.token`` ne contient QUE cette empreinte : une
    fuite de la table ne permet pas de rejouer une session. Même choix que
    pour les sessions élève (``store._hash_token``).
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def hash_token(token: str) -> str:
    """Empreinte SHA-256 d'un jeton admin (API publique).

    Utilisée par les appelants qui doivent retrouver la ligne `admin_lock`
    par jeton brut — la colonne ne stocke que l'empreinte.
    """
    return _hash_token(token)


def _token_matches(lock: AdminLockORM, token: str) -> bool:
    """Comparaison en temps constant du jeton fourni avec l'empreinte stockée."""
    return hmac.compare_digest(lock.token or "", _hash_token(token))


def session_timeout() -> timedelta:
    """Fenêtre d'inactivité de la session admin, en minutes. Un admin qui
    ferme la page cesse de rafraîchir le verrou : il est automatiquement
    déconnecté une fois ce délai écoulé (la prochaine requête recevra 401
    et le frontend purge sa session locale)."""
    raw = os.getenv("ADMIN_SESSION_TIMEOUT_MINUTES", "").strip()
    try:
        minutes = float(raw) if raw else ADMIN_SESSION_TIMEOUT_DEFAULT_MINUTES
    except ValueError:
        log.warning("ADMIN_SESSION_TIMEOUT_MINUTES invalide (%r) — défaut %s min utilisé", raw, ADMIN_SESSION_TIMEOUT_DEFAULT_MINUTES)
        minutes = ADMIN_SESSION_TIMEOUT_DEFAULT_MINUTES
    return timedelta(minutes=max(0.5, minutes))


def root_emails() -> set[str]:
    """Emails ROOT de l'administration (un seul en principe, `ADMIN_ROOT`),
    en minuscules. Seul le root peut promouvoir (ou révoquer) un admin."""
    raw = os.getenv("ADMIN_ROOT", "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def promoted_emails(db: Optional[Session]) -> set[str]:
    """Emails promus ADMIN celui de la liste blanche (colonne
    `users.role='admin'`, posée par un ADMIN_ROOT du back-office) — ce sont
    des utilisateurs comme les autres, bannissables/délégables/retirables
    depuis cette même table admin."""
    if db is None:
        return set()
    return {email.lower() for (email,) in db.query(UserORM.email).filter(UserORM.role == "admin").all()}


def allowed_emails(db: Optional[Session] = None) -> set[str]:
    """Liste blanche admin = ROOT (`ADMIN_ROOT`) ∪ promus (`users.role =
    "admin"`). Sans session (`db=None`), seuls les emails ROOT sont
    retournés — appelé en défensif par du code hors requête (aucune requête
    SQL n'est possible sans session)."""
    return root_emails() | promoted_emails(db)


def align_root_role(db: Session, email: str) -> None:
    """Aligne `users.role` sur "admin" pour un email ROOT à son login : le
    rôle en base reste LISIBLE et cohérent, mais la reconnaissance admin est
    toujours calculée par `allowed_emails` (cette colonne ne fait pas foi à
    elle seule)."""
    if email.strip().lower() not in root_emails():
        return
    user = db.query(UserORM).filter(UserORM.email == email).one_or_none()
    if user is not None and user.role != "admin":
        user.role = "admin"
        db.commit()


def _get_lock(db: Session) -> Optional[AdminLockORM]:
    """Lit la ligne unique de verrou admin (id="singleton"), ou None si
    personne n'est connecté."""
    return db.query(AdminLockORM).filter(AdminLockORM.id == LOCK_ID).one_or_none()


def _is_expired(lock: AdminLockORM) -> bool:
    """Vrai si la session admin doit être libérée.

    Deux bornes indépendantes : l'inactivité (``last_activity`` +
    ``session_timeout``) et la durée ABSOLUE depuis l'ouverture (``since`` +
    ``session_max_duration``). La seconde empêche qu'un jeton volé survive
    indéfiniment à force de requêtes ou de heartbeats.
    """
    now = utc_now()
    if now - lock.last_activity > session_timeout():
        return True
    return now - lock.since > session_max_duration()


def attempt_login(
    db: Session, email: str, force: bool = False
) -> tuple[Optional[AdminLockORM], Optional[str], Optional[dict]]:
    """Ouvre une session admin (une ligne unique dans `admin_lock`, id
    fixe ``singleton``), ou retourne le bloqueur si un autre admin est
    actif sans `force`. Persisté en base plutot qu'en mémoire : un
    redémarrage du backend ne libère plus silencieusement l'accès —
    seule l'expiration (inactivité OU durée absolue) ou une déconnexion
    explicite le fait.

    Retourne ``(lock, token, blocker)``. Le jeton **brut** est renvoyé à
    l'appelant qui le pose dans le cookie httpOnly ; la base n'en conserve
    que l'empreinte SHA-256. Il n'est jamais renvoyé au client.
    """
    email = email.strip().lower()
    lock = _get_lock(db)

    if lock is not None and _is_expired(lock):
        log.info(
            "Session admin de %s expirée (inactivité > %s ou durée absolue dépassée) — verrou libéré",
            lock.email,
            session_timeout(),
        )
        db.delete(lock)
        db.commit()
        lock = None

    if lock is not None and lock.email != email and not force:
        blocker = {
            "message": f"Un autre administrateur ({lock.email}) est déjà connecté.",
            "active_email": lock.email,
            "since": lock.since.isoformat(),
        }
        return None, None, blocker

    if lock is not None and lock.email != email and force:
        log.warning("Prise de contrôle forcée de la session admin par %s (précédent: %s)", email, lock.email)

    token = uuid.uuid4().hex
    token_hash = _hash_token(token)
    now = utc_now()
    if lock is not None:
        lock.email = email
        lock.token = token_hash
        lock.since = now
        lock.last_activity = now
    else:
        # Création de la ligne singleton. L'UPDATE conditionnel d'abord (id
        # fixe, jamais plus d'une ligne) ; l'INSERT seulement si rien n'a été
        # mis à jour. Deux logins simultanés sur base vide peuvent encore
        # tous deux INSERTer (fenêtre entre l'UPDATE et l'INSERT) : le second
        # viole alors la clé primaire, qu'on absorbe pour qu'il reprenne la
        # ligne de l'autre.
        from sqlalchemy import update

        changed = db.execute(
            update(AdminLockORM)
            .where(AdminLockORM.id == LOCK_ID)
            .values(email=email, token=token_hash, since=now, last_activity=now)
        ).rowcount
        if changed == 0:
            try:
                db.add(
                    AdminLockORM(
                        id=LOCK_ID, email=email, token=token_hash, since=now, last_activity=now
                    )
                )
                db.commit()
            except IntegrityError:
                db.rollback()
                updated = db.execute(
                    update(AdminLockORM)
                    .where(AdminLockORM.id == LOCK_ID)
                    .values(email=email, token=token_hash, since=now, last_activity=now)
                )
                if updated.rowcount == 0:
                    db.add(
                        AdminLockORM(
                            id=LOCK_ID, email=email, token=token_hash, since=now, last_activity=now
                        )
                    )
    db.commit()
    lock = _get_lock(db)
    log.info("Session admin ouverte pour %s (persistée en base)", email)
    return lock, token, None


def touch(db: Session, token: str) -> Optional[AdminLockORM]:
    """Valide un jeton de session admin et rafraîchit son horodatage
    d'activité (glissement de la fenêtre de `session_timeout`) ; libère et
    retourne None si le verrou a expiré.

    La colonne `token` ne contient que l'empreinte SHA-256 du jeton : la
    comparaison est faite en temps constant sur les deux empreintes.
    """
    lock = _get_lock(db)
    if lock is None or not _token_matches(lock, token):
        return None
    if _is_expired(lock):
        log.info(
            "Session admin de %s expirée (inactivité > %s ou durée absolue dépassée) — verrou libéré",
            lock.email,
            session_timeout(),
        )
        db.delete(lock)
        db.commit()
        return None
    lock.last_activity = utc_now()
    db.commit()
    db.refresh(lock)
    return lock


def logout(db: Session, token: str) -> None:
    """Libère le verrou admin s'il correspond au jeton fourni."""
    lock = _get_lock(db)
    if lock is not None and _token_matches(lock, token):
        log.info("Déconnexion admin de %s", lock.email)
        db.delete(lock)
        db.commit()
