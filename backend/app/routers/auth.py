from __future__ import annotations

import os

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from sqlalchemy.orm import Session

from ..core import store
from ..core.logging_config import get_logger
from ..db import get_db
from ..models import AuthConfigOut, GoogleLoginIn, MockLoginIn, UserOut

router = APIRouter(prefix="/api/auth", tags=["auth"])
log = get_logger("auth")

COOKIE_NAME = "bacprep_session"


def _set_session_cookie(response: Response, token: str) -> None:
    """Pose le cookie de session HTTP-only (1 an) sur la réponse."""
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 365,
    )


@router.get("/config", response_model=AuthConfigOut)
def auth_config() -> AuthConfigOut:
    """Source de vérité unique pour le frontend : indique s'il doit afficher
    le formulaire simulé (mode "mock") ou le bouton Google Identity Services
    (mode "google"). Retombe automatiquement sur "mock" si AUTH_MODE=google
    est positionné sans GOOGLE_CLIENT_ID valide, plutôt que de casser la
    connexion (voir CAHIER_DES_CHARGES, Module 1)."""
    mode = os.getenv("AUTH_MODE", "mock").strip().lower()
    client_id = os.getenv("GOOGLE_CLIENT_ID", "").strip()
    if mode == "google" and not client_id:
        log.warning("AUTH_MODE=google mais GOOGLE_CLIENT_ID absent — retombe sur le mode mock")
        mode = "mock"
    return AuthConfigOut(mode=mode, google_client_id=client_id or None)


@router.post("/mock-login", response_model=UserOut)
async def mock_login(payload: MockLoginIn, response: Response, db: Session = Depends(get_db)) -> UserOut:
    """Connexion simulée (mode développement/démonstration) : crée
    l'utilisateur au premier login, ouvre une session unique (invalidant
    toute session précédente avec notification de kick-out en temps réel),
    et pose le cookie de session."""
    user = store.get_or_create_user(db, payload.email.strip().lower(), payload.nom.strip())
    token, _ = await store.create_session(db, user.id, payload.platform)
    _set_session_cookie(response, token)
    log.info("Connexion mock réussie: %s", user.email)
    return UserOut(id=user.id, email=user.email, nom=user.nom, created_at=user.created_at)


@router.post("/google-login", response_model=UserOut)
async def google_login(payload: GoogleLoginIn, response: Response, db: Session = Depends(get_db)) -> UserOut:
    """Connexion via Google Identity Services : vérifie le ID token JWT
    reçu du client (signature + claim email_verified) avant de créer ou
    retrouver l'utilisateur et d'ouvrir sa session."""
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
    token, _ = await store.create_session(db, user.id, payload.platform)
    _set_session_cookie(response, token)
    log.info("Connexion Google réussie: %s", user.email)
    return UserOut(id=user.id, email=user.email, nom=user.nom, created_at=user.created_at)


@router.get("/me", response_model=UserOut)
def me(
    bacprep_session: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> UserOut:
    """Retourne l'utilisateur courant si le cookie de session est valide,
    401 sinon. Interrogé par le frontend au montage de l'application pour
    savoir si l'utilisateur est déjà connecté."""
    user = store.resolve_session(db, bacprep_session or "")
    if not user:
        raise HTTPException(401, "Non authentifié")
    return UserOut(id=user.id, email=user.email, nom=user.nom, created_at=user.created_at)


@router.get("/kickout-notice/{user_id}")
def kickout_notice(user_id: str, db: Session = Depends(get_db)) -> dict:
    """Filet de secours historique (v0), conservé mais plus interrogé en
    continu par le frontend depuis le passage au WebSocket (v2.0)."""
    message = store.pop_kickout_notice(db, user_id)
    return {"message": message}


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


def optional_user(
    bacprep_session: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
):
    """Variante nullable de `require_user` : renvoie None au lieu de lever
    401. Utilisée par les routes qui acceptent PLUSIEURS voies d'accès (ex.
    GET /api/files/{id} : jeton signé OU session valide) — la route décide
    elle-même quoi faire quand l'utilisateur est absent."""
    return store.resolve_session(db, bacprep_session or "")
