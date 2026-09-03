from __future__ import annotations

import os
import uuid
from datetime import timedelta
from typing import Optional

from sqlalchemy.orm import Session

from ..db import utc_now
from ..db_models import AdminLockORM
from .logging_config import get_logger

log = get_logger("admin_session")

ADMIN_SESSION_TIMEOUT = timedelta(minutes=30)
LOCK_ID = "singleton"


def allowed_emails() -> set[str]:
    """Liste blanche d'emails admin (CSV, `ADMIN_EMAILS`), en minuscules."""
    raw = os.getenv("ADMIN_EMAILS", "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def _get_lock(db: Session) -> Optional[AdminLockORM]:
    """Lit la ligne unique de verrou admin (id="singleton"), ou None si
    personne n'est connecté."""
    return db.query(AdminLockORM).filter(AdminLockORM.id == LOCK_ID).one_or_none()


def _is_expired(lock: AdminLockORM) -> bool:
    """Vrai si la session admin n'a plus eu d'activité depuis plus de
    ADMIN_SESSION_TIMEOUT (30 min)."""
    return utc_now() - lock.last_activity > ADMIN_SESSION_TIMEOUT


def attempt_login(db: Session, email: str, force: bool = False) -> tuple[Optional[AdminLockORM], Optional[dict]]:
    """Persisté en base (table `admin_lock`, une seule ligne) plutôt qu'en
    mémoire : un redémarrage du backend ne libère plus silencieusement
    l'accès admin — seule l'expiration par inactivité (30 min) ou une
    déconnexion explicite le fait."""
    email = email.strip().lower()
    lock = _get_lock(db)

    if lock is not None and _is_expired(lock):
        log.info("Session admin de %s expirée (inactivité > 30 min) — verrou libéré", lock.email)
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
        lock = AdminLockORM(id=LOCK_ID, email=email, token=token, since=now, last_activity=now)
        db.add(lock)
    db.commit()
    db.refresh(lock)
    log.info("Session admin ouverte pour %s (persistée en base)", email)
    return lock, None


def touch(db: Session, token: str) -> Optional[AdminLockORM]:
    """Valide un jeton de session admin et rafraîchit son horodatage
    d'activité (glissement de la fenêtre de 30 min) ; libère et retourne
    None si le verrou a expiré."""
    lock = _get_lock(db)
    if lock is None or lock.token != token:
        return None
    if _is_expired(lock):
        log.info("Session admin de %s expirée (inactivité > 30 min) — verrou libéré", lock.email)
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
