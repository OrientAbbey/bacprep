from __future__ import annotations

import os
import uuid
from datetime import timedelta
from typing import Optional

from sqlalchemy.orm import Session

from ..db import utc_now
from ..db_models import AdminLockORM, UserORM
from .logging_config import get_logger

log = get_logger("admin_session")

# Défaut de la fenêtre d'inactivité admin : 3 minutes. Paramétrable via
# ADMIN_SESSION_TIMEOUT_MINUTES (lu dynamiquement — un redémarrage du
# backend suffit à l'appliquer, ou via l'env du process de service).
ADMIN_SESSION_TIMEOUT_DEFAULT_MINUTES = 3
LOCK_ID = "singleton"


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
    en minuscules. Seul le root peut promouvoir (ou révoquer) un admin.
    `ADMIN_EMAILS` reste accepté comme alias historique pour la migration
    des .env existants."""
    raw = os.getenv("ADMIN_ROOT", "") or os.getenv("ADMIN_EMAILS", "")
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
    """Vrai si la session admin n'a plus eu d'activité depuis plus de la
    fenêtre d'inactivité configurée (ADMIN_SESSION_TIMEOUT_MINUTES)."""
    return utc_now() - lock.last_activity > session_timeout()


def attempt_login(db: Session, email: str, force: bool = False) -> tuple[Optional[AdminLockORM], Optional[dict]]:
    """Ouvre une session admin (une ligne unique dans `admin_lock`, id
    fixe ``singleton``), ou retourne le bloqueur si un autre admin est
    actif sans `force`. Persisté en base plutot qu'en mémoire : un
    redémarrage du backend ne libère plus silencieusement l'accès —
    seule l'expiration par inactivité (session_timeout) ou une
    déconnexion explicite le fait."""
    email = email.strip().lower()
    lock = _get_lock(db)

    if lock is not None and _is_expired(lock):
        log.info("Session admin de %s expirée (inactivité > %s) — verrou libéré", lock.email, session_timeout())
        db.delete(lock)
        db.commit()
        lock = None

    if lock is not None and lock.email != email and not force:
        blocker = {
            "message": f"Un autre administrateur ({lock.email}) est déjà connecté.",
            "active_email": lock.email,
            "since": lock.since.isoformat(),
        }
        return None, blocker

    if lock is not None and lock.email != email and force:
        log.warning("Prise de contrôle forcée de la session admin par %s (précédent: %s)", email, lock.email)

    token = uuid.uuid4().hex
    now = utc_now()
    if lock is not None:
        lock.email = email
        lock.token = token
        lock.since = now
        lock.last_activity = now
    else:
        # Création ATOMIQUE de la ligne singleton : UPDATE conditionnel
        # d'abord (id fixe, jamais plus d'une ligne), l'INSERT n'a lieu que
        # si aucune ligne n'a été mise à jour. Deux logins simultanés sur
        # base vide ne déclenchent plus d'IntegrityError de la contrainte
        # PK : successifs, ils reprennent simplement la ligne de l'autre.
        from sqlalchemy import update

        changed = db.execute(
            update(AdminLockORM)
            .where(AdminLockORM.id == LOCK_ID)
            .values(email=email, token=token, since=now, last_activity=now)
        ).rowcount
        if changed == 0:
            db.add(AdminLockORM(id=LOCK_ID, email=email, token=token, since=now, last_activity=now))
    db.commit()
    lock = _get_lock(db)
    log.info("Session admin ouverte pour %s (persistée en base)", email)
    return lock, None


def touch(db: Session, token: str) -> Optional[AdminLockORM]:
    """Valide un jeton de session admin et rafraîchit son horodatage
    d'activité (glissement de la fenêtre de `session_timeout`) ; libère et
    retourne None si le verrou a expiré."""
    lock = _get_lock(db)
    if lock is None or lock.token != token:
        return None
    if _is_expired(lock):
        log.info("Session admin de %s expirée (inactivité > %s) — verrou libéré", lock.email, session_timeout())
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
    if lock is not None and lock.token == token:
        log.info("Déconnexion admin de %s", lock.email)
        db.delete(lock)
        db.commit()
