from __future__ import annotations

import os

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from sqlalchemy.orm import Session

from ..core import admin_session, store
from ..core.config import demo_allowed
from ..core.logging_config import get_logger
from ..core.rate_limit import SlidingWindowLimiter, client_ip
from ..db import get_db, utc_now
from ..models import AuthConfigOut, GoogleLoginIn, MockLoginIn, UserOut

router = APIRouter(prefix="/api/auth", tags=["auth"])
log = get_logger("auth")

COOKIE_NAME = "bacprep_session"


def _user_out(user) -> UserOut:
    """Projette un utilisateur vers la réponse API : `is_admin` est calculé
    serveur (email ∈ ADMIN_EMAILS) pour que le frontend puisse conditionner
    le lien/page admin SANT jamais recevoir la liste blanche elle-même."""
    return UserOut(
        id=user.id,
        email=user.email,
        nom=user.nom,
        created_at=user.created_at,
        is_admin=user.email.lower() in admin_session.allowed_emails(),
        consent_ia=user.consent_ia,
        consent_notes=user.consent_notes,
    )

# Freine le brute-force / l'énumération d'emails sur les deux logins.
# Même interrupteur que le login admin (LOGIN_RATE_LIMIT) pour les tests ;
# actif par défaut, y compris en dev.
_login_limiter = SlidingWindowLimiter(
    max_attempts=10,
    window_seconds=300.0,
    message="Trop de tentatives de connexion — réessaie dans quelques minutes",
    env_switch="LOGIN_RATE_LIMIT",
)


def _set_session_cookie(response: Response, token: str) -> None:
    """Pose le cookie de session HTTP-only sur la réponse — même durée de
    vie MAXIMALE que la session serveur (14 jours, cf. `store.
    SESSION_TTL_MAX` : expiration glissante 7 jours côté serveur, mais le
    cookie ne survit jamais à la durée maximale absolue). ``Secure`` en
    production (ENV=prod) pour que le cookie ne parte jamais sur un http en
    clair."""
    from ..core.config import is_prod
    from ..core.store import SESSION_TTL_MAX

    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        secure=is_prod(),
        max_age=int(SESSION_TTL_MAX.total_seconds()),
    )


@router.get("/config", response_model=AuthConfigOut)
def auth_config() -> AuthConfigOut:
    """Source de vérité unique pour le frontend : indique s'il doit afficher
    le formulaire simulé (mode "mock") ou le bouton Google Identity Services
    (mode "google"). Retombe automatiquement sur "mock" si AUTH_MODE=google
    est positionné sans GOOGLE_CLIENT_ID valide, plutôt que de casser la
    connexion (voir CAHIER_DES_CHARGES, Module 1)."""
    mode = _resolved_auth_mode()
    client_id = os.getenv("GOOGLE_CLIENT_ID", "").strip()
    return AuthConfigOut(mode=mode, google_client_id=client_id or None)


def _resolved_auth_mode() -> str:
    """Mode d'authentification réellement actif (même logique que
    `auth_config` — source de vérité partagée pour le frontend ET le
    garde-fou serveur de `mock_login`)."""
    mode = os.getenv("AUTH_MODE", "mock").strip().lower()
    client_id = os.getenv("GOOGLE_CLIENT_ID", "").strip()
    if mode == "google" and not client_id:
        mode = "mock"
    return mode


def require_user(
    bacprep_session: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
):
    """Dépendance FastAPI réutilisée par toutes les routes élève protégées :
    résout l'utilisateur depuis le cookie de session, lève 401 sinon."""
    user = store.resolve_session(db, bacprep_session or "")
    if not user:
        raise HTTPException(401, "Non authentifié")
    return user


@router.post("/mock-login", response_model=UserOut)
async def mock_login(payload: MockLoginIn, request: Request, response: Response, db: Session = Depends(get_db)) -> UserOut:
    """Connexion simulée (mode développement/démonstration) : crée
    l'utilisateur au premier login, ouvre une session unique (invalidant
    toute session précédente avec notification de kick-out en temps réel),
    et pose le cookie de session.

    Garde-fous : REFUSÉ (403) dès que le mode actif n'est pas "mock" —
    sinon n'importe qui connaissant l'email d'un élève pourrait ouvrir sa
    session sans preuve de possession — et REFUSÉ en production
    (ENV=prod) sauf DEMO_MODE=true explicite (démo publique hébergée).
    Rate-limité par IP contre l'énumération d'emails."""
    if _resolved_auth_mode() != "mock":
        raise HTTPException(403, "Connexion simulée désactivée (AUTH_MODE != mock)")
    if not demo_allowed():
        log.warning("mock-login refusé en production sans DEMO_MODE")
        raise HTTPException(403, "Connexion simulée désactivée en production")
    _login_limiter.check(client_ip(request))
    user = store.get_or_create_user(db, payload.email.strip().lower(), payload.nom.strip())
    if user.banni:
        raise HTTPException(403, "Compte suspendu — contacte l'équipe via ta page profil ou par e-mail.")
    user.derniere_connexion = utc_now()
    db.add(user)
    db.commit()
    token = await store.create_session(db, user.id, payload.platform)
    _set_session_cookie(response, token)
    log.info("Connexion mock réussie: %s", user.email)
    return _user_out(user)


@router.post("/google-login", response_model=UserOut)
async def google_login(payload: GoogleLoginIn, request: Request, response: Response, db: Session = Depends(get_db)) -> UserOut:
    """Connexion via Google Identity Services : vérifie le ID token JWT
    reçu du client (signature + claim email_verified) avant de créer ou
    retrouver l'utilisateur et d'ouvrir sa session. Rate-limité par IP."""
    _login_limiter.check(client_ip(request))
    client_id = os.getenv("GOOGLE_CLIENT_ID", "")
    if not client_id:
        raise HTTPException(400, "GOOGLE_CLIENT_ID non configuré côté serveur")
    try:
        info = google_id_token.verify_oauth2_token(
            payload.id_token, google_requests.Request(), client_id
        )
    except Exception as exc:
        log.warning("Échec de vérification du ID token Google: %s", exc)
        raise HTTPException(401, "Jeton Google invalide") from exc

    if not info.get("email_verified"):
        raise HTTPException(401, "Adresse e-mail Google non vérifiée")

    email = info["email"].strip().lower()
    nom = info.get("name", email.split("@")[0])
    user = store.get_or_create_user(db, email, nom)
    if user.banni:
        raise HTTPException(403, "Compte suspendu — contacte l'équipe via ta page profil ou par e-mail.")
    user.derniere_connexion = utc_now()
    db.add(user)
    db.commit()
    token = await store.create_session(db, user.id, payload.platform)
    _set_session_cookie(response, token)
    log.info("Connexion Google réussie: %s", user.email)
    return _user_out(user)


@router.get("/me", response_model=UserOut)
def me(user=Depends(require_user)) -> UserOut:
    """Retourne l'utilisateur courant si le cookie de session est valide,
    401 sinon. Interrogé par le frontend au montage de l'application pour
    savoir si l'utilisateur est déjà connecté."""
    return _user_out(user)


@router.post("/logout")
def logout(
    response: Response,
    bacprep_session: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> dict:
    """Déconnexion explicite : supprime la session côté serveur et le
    cookie côté client."""
    if bacprep_session:
        store.end_session(db, bacprep_session)
    response.delete_cookie(COOKIE_NAME)
    return {"ok": True}


@router.get("/kickout-notice/{user_id}")
def kickout_notice(
    user_id: str,
    db: Session = Depends(get_db),
    user=Depends(require_user),
) -> dict:
    """Filet de secours historique (v0), conservé mais plus interrogé en
    continu par le frontend depuis le passage au WebSocket (v2.0).
    Exige une session : on ne peut lire que SA propre notification."""
    if user.id != user_id:
        raise HTTPException(403, "Notification inaccessible")
    message = store.pop_kickout_notice(db, user_id)
    return {"message": message}


def optional_user(
    bacprep_session: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
):
    """Variante nullable de `require_user` : renvoie None au lieu de lever
    401. Utilisée par les routes qui acceptent PLUSIEURS voies d'accès (ex.
    GET /api/files/{id} : jeton signé OU session valide) — la route décide
    elle-même quoi faire quand l'utilisateur est absent."""
    return store.resolve_session(db, bacprep_session or "")
