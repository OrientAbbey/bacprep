from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

# Chemin ABSOLU vers backend/.env, calculé depuis l'emplacement de ce
# fichier — jamais relatif au répertoire de travail courant. Bug corrigé :
# `load_dotenv()` sans argument ne trouve `.env` que si `uvicorn` est lancé
# depuis le dossier `backend/` lui-même ; lancé depuis la racine du dépôt
# (ou tout autre dossier), le fichier n'était pas trouvé et TOUTES les
# variables d'environnement (ADMIN_ROOT, ADMIN_TOKEN, clés LLM...)
# retombaient silencieusement sur leurs valeurs par défaut. Même principe
# que pour BASE_DIR dans db.py (voir CAHIER_DES_CHARGES, section 3).
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=_ENV_FILE)

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .core import store
from .core.catalogue import seed_database_if_empty
from .core.config import is_prod
from .core.logging_config import get_logger, setup_logging
from .db import Base, SessionLocal, engine
from .routers import (
    admin_assistant,
    admin_epreuves,
    admin_import,
    admin_misc,
    admin_notifications,
    admin_referentiel,
    assistant,
    auth,
    epreuves,
    files,
    me,
    notifications,
    subscriptions,
    ws,
)

setup_logging()
log = get_logger("main")

BASE_DIR = Path(__file__).resolve().parent.parent  # backend/
FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"
if not _ENV_FILE.exists() and not is_prod():
    log.warning(
        "Aucun fichier .env trouvé à %s — copie backend/.env.example vers backend/.env "
        "si tu veux configurer ADMIN_ROOT, les clés LLM, etc.",
        _ENV_FILE,
    )

MAX_CONVERSATIONS_PAR_EPREUVE = store.MAX_CONVERSATIONS_PAR_EPREUVE
MAX_HISTORIQUE = store.MAX_HISTORIQUE


def _ensure_users_role_column() -> None:
    """Migration minimale et idempotente : ajoute la colonne `users.role`
    aux bases créées avant l'introduction des rôles. `create_all` ne crée
    QUE les tables absentes et ne modifie jamais une table existante. La
    syntaxe `ALTER TABLE ... ADD COLUMN ... DEFAULT` est acceptée à la
    fois par SQLite et PostgreSQL."""
    from sqlalchemy import inspect as sa_inspect
    from sqlalchemy import text as sa_text

    try:
        colonnes = {c["name"] for c in sa_inspect(engine).get_columns("users")}
    except Exception:
        # Table vide ou absente (premier démarrage) : rien à migrer.
        return
    if "role" not in colonnes:
        with engine.begin() as conn:
            conn.execute(sa_text("ALTER TABLE users ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'user'"))


def _ensure_epreuve_files_sujet_index() -> None:
    """Migration minimale et idempotente pour le multi-sujets : ajoute la
    colonne `epreuve_files.sujet_index` (INTEGER NOT NULL DEFAULT 0). Les
    bases existantes (créées avant ce chantier) posent cette colonne à 0 —
    chaque document hérite ainsi de l'index du sujet principal, aucun
    renommage de fichier n'est nécessaire (la clé de l'index 0 conserve le
    nom historique `sujet.md`/`corrige.md`)."""
    from sqlalchemy import inspect as sa_inspect
    from sqlalchemy import text as sa_text

    try:
        colonnes = {c["name"] for c in sa_inspect(engine).get_columns("epreuve_files")}
    except Exception:
        return
    if "sujet_index" not in colonnes:
        with engine.begin() as conn:
            conn.execute(sa_text("ALTER TABLE epreuve_files ADD COLUMN sujet_index INTEGER NOT NULL DEFAULT 0"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Crée les tables au démarrage (pas de migrations dans ce prototype —
    `Base.metadata.create_all` suffit), applique les micro-migrations des
    colonnes `users.role` et `epreuve_files.sujet_index`, et importe le
    contenu de seed si la table `epreuves` est vide. Le seed n'est PAS
    bloquant : un échec de stockage (bucket manquant, réseau…) est
    journalisé et le serveur démarre quand même — l'import reste possible
    ensuite via l'admin."""
    Base.metadata.create_all(bind=engine)
    _ensure_users_role_column()
    _ensure_epreuve_files_sujet_index()
    db = SessionLocal()
    try:
        from .core.referentiel_options import seed_referentiel_options

        seed_referentiel_options(db)
    except Exception:
        log.exception("Seed referentiel_options impossible au démarrage")
    try:
        seed_database_if_empty(db)
    except Exception:
        log.exception(
            "Seed du catalogue impossible au démarrage — le serveur démarre "
            "sans contenu (vérifier le backend de stockage / le bucket)."
        )
    finally:
        db.close()
    log.info(
        "Démarrage backend — DATABASE_URL=%s",
        engine.url.render_as_string(hide_password=True),
    )
    yield
    log.info("Arrêt backend")


# Documentation OpenAPI : publique en développement, en production servie à
# un chemin secret (DOCS_PATH) ou totalement fermée si DOCS_PATH absent —
# Voir DEPLOIEMENT.md/Render. Swagger UI (rechargé par le navigateur) suit
# automatiquement openapi_url sous le même chemin secret.
docs_path = os.getenv("DOCS_PATH", "").strip().strip("/")
if is_prod() and not docs_path:
    docs_url = redoc_url = openapi_url = None
else:
    docs_url = f"/{docs_path}" if docs_path else "/docs"
    redoc_url = f"/{docs_path}/redoc" if docs_path else "/redoc"
    openapi_url = f"/{docs_path}/openapi.json" if docs_path else "/openapi.json"

log.info(
    "Documentation OpenAPI active: %s",
    docs_url or "désactivée en production (DOCS_PATH non défini)",
)

app = FastAPI(
    title="Copies & Corrigés API",
    lifespan=lifespan,
    docs_url=docs_url,
    redoc_url=redoc_url,
    openapi_url=openapi_url,
)

app.add_middleware(GZipMiddleware, minimum_size=1024)

# Headers de sécurité de base sur toutes les réponses (dont le frontend
# servi en service unifié). Pas de CSP complète pour l'instant : Google
# Identity Services injecte un iframe + scripts inline et KaTeX pose des
# styles inline — une politique trop stricte casserait la connexion
# Google et le rendu des formules ; à introduire en report-only d'abord.
@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    if is_prod():
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response

# Origines autorisées : configurable via CORS_ORIGINS (liste séparée par des
# virgules). Défaut : le serveur de dev Vite (frontend et backend ont des
# origines distinctes en local, d'où allow_credentials=True pour le dev).
# En production, le déploiement est un service UNIFIÉ (backend sert le
# frontend build sur la même origine) : CORS n'intervient pas — l'origine
# exacte du domaine est déclarée via CORS_ORIGINS si besoin. Plus de regex
# `https://*.onrender.com` ici : tous les sous-domaines onrender.com
# partagent le même site (SameSite=Lax ne bloque donc rien), ainsi
# autoriser n'importe quelle app gratuite onrender.com en origine
# permettrait à un site tiers d'envoyer des requêtes credentialées
# (lecture du profil/des notes, URLs signées des corrigés) sans jamais
# être bloqué par le navigateur.
_cors_origins = [
    o.strip() for o in (os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")) if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-Admin-Session"],
)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Journalise les erreurs de validation (422) — essentiel pour
    diagnostiquer une désynchronisation frontend/backend sur la forme d'une
    requête (voir CAHIER_DES_CHARGES, section 12.1 et 12.8).

    Le corps brut n'est plus loggé en WARNING : il peut contenir des
    données sensibles (ex. un id_token Google sur un google-login mal
    formé) — il passe en DEBUG et tronqué à 500 caractères."""
    try:
        body = await request.body()
        body_text = body.decode("utf-8", errors="replace")[:500]
    except Exception:
        body_text = "<illisible>"
    log.warning(
        "Erreur de validation (422) sur %s %s — erreurs=%s",
        request.method,
        request.url.path,
        exc.errors(),
    )
    log.debug("Corps brut (tronqué) reçu : %s", body_text)
    # jsonable_encoder : les erreurs pydantic contiennent parfois des objets
    # non sérialisables (ex. ValueError dans ctx des @field_validator).
    from fastapi.encoders import jsonable_encoder

    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(exc.errors())})


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Filet de sécurité : aucune exception non gérée ne doit rester
    silencieuse — journalise la trace complète avant de renvoyer une 500
    générique (jamais de détail d'implémentation exposé au client)."""
    log.exception("Exception non gérée sur %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(status_code=500, content={"detail": "Erreur interne du serveur"})


app.include_router(auth.router)
app.include_router(epreuves.router)
app.include_router(files.router)
app.include_router(subscriptions.router)
app.include_router(admin_misc.router)
app.include_router(admin_epreuves.router)
app.include_router(admin_import.router)
app.include_router(admin_referentiel.router)
app.include_router(admin_notifications.router)
app.include_router(admin_assistant.router)
app.include_router(assistant.router)
app.include_router(me.router)
app.include_router(notifications.router)
app.include_router(ws.router)


@app.get("/api/health")
def health() -> dict:
    """Sonde de santé simple — utilisée pour vérifier que le backend a
    démarré. (N'expose plus `env_file_found`, détail de configuration
    inutile en public.)"""
    return {"status": "ok"}


@app.get("/api/config")
def config() -> dict:
    """Constantes publiques exposées au frontend (plafonds applicatifs)."""
    return {
        "max_conversations_par_epreuve": MAX_CONVERSATIONS_PAR_EPREUVE,
        "max_historique": MAX_HISTORIQUE,
    }


if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    _FRONTEND_DIST_RESOLVED = FRONTEND_DIST.resolve()

    @app.get("/{full_path:path}")
    async def spa_catch_all(full_path: str):
        """Sert `frontend/dist` (service unifié, voir DEPLOIEMENT.md) :
        toute route qui n'est ni une API ni un fichier statique existant
        renvoie `index.html`, laissant React Router gérer la navigation
        côté client plutôt que de renvoyer une 404.

        Sécurité : le chemin est résolu puis CONFINÉ à frontend/dist (même
        garde que LocalStorage._path) — sans ce contrôle, une requête
        brute `/../backend/.env` (curl ne normalise pas les segments
        contrairement aux navigateurs) sortait du dossier et servait un
        fichier arbitraire, .env compris. Les chemins /api/* inconnus
        répondent 404 JSON (contrat d'API) plutôt qu'index.html."""
        if full_path.startswith("api/") or full_path == "api":
            return JSONResponse(status_code=404, content={"detail": "Ressource API introuvable"})
        if full_path:
            candidate = (FRONTEND_DIST / full_path).resolve()
            if candidate.is_file() and candidate.is_relative_to(_FRONTEND_DIST_RESOLVED):
                return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")

    log.info("Service unifié activé: frontend/dist servi par le backend")
else:
    log.info("frontend/dist absent — l'API tourne seule (mode développement)")
