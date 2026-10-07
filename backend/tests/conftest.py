"""Fixtures pytest : app FastAPI sur SQLite temporaire, env posé AVANT
l'import d'app.main (inspiré de scripts_dev/smoke_v4.py, mais collectable
par pytest)."""
from __future__ import annotations

import os
import tempfile

# Env à positionner avant tout import d'app.* (les modules lisent os.getenv
# à l'import pour certains réglages).
_TMP = tempfile.mkdtemp(prefix="bacprep_test_")
# TEST_DATABASE_URL (ex. postgresql+psycopg://…) : exécute la suite sur un vrai
# PostgreSQL ; le schéma est alors recréé à vide avant les tests.
os.environ["DATABASE_URL"] = os.getenv("TEST_DATABASE_URL") or f"sqlite:///{_TMP}/test.db"
os.environ["FILE_URL_SECRET"] = "t" * 32
os.environ["ADMIN_TOKEN"] = "test-admin-token"
os.environ["PAYMENT_WEBHOOK_SECRET"] = "test-webhook-secret"
os.environ["ADMIN_ROOT"] = "admin@example.com"
os.environ["AUTH_MODE"] = "mock"
os.environ["ENV"] = "dev"
os.environ["STORAGE_BACKEND"] = "local"
os.environ["CORS_ORIGINS"] = "http://localhost:5173"
# Les tests multiplient les logins admin : pas de rate-limit en test.
os.environ["LOGIN_RATE_LIMIT"] = "0"
os.environ["ASSISTANT_RATE_LIMIT"] = "0"

import pytest
from fastapi.testclient import TestClient

import app.main as app_main

if os.environ["DATABASE_URL"].startswith("postgres"):
    from app.db import Base, engine

    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def client():
    """Client de test SANS session (visiteur anonyme)."""
    with TestClient(app_main.app) as c:
        yield c


@pytest.fixture()
def visiteur(client):
    """VRAI client visiteur : instance fraîche (jarre de cookies vide),
    indépendante du client partagé que les fixtures eleve/admin ont
    connecté. Réutilise la base déjà initialisée par le lifespan de
    `client`."""
    return TestClient(app_main.app)


@pytest.fixture()
def eleve(client):
    """Client AYANT une session élève (mock-login), plus l'utilisateur."""
    r = client.post("/api/auth/mock-login", json={"email": "eleve@test.cm", "nom": "Élève Test"})
    assert r.status_code == 200, r.text
    return client


@pytest.fixture()
def admin(eleve):
    """Client élève AYANT AUSSI une session admin (cookie admin_session)."""
    r = eleve.post("/api/admin/login", json={"email": "admin@example.com", "token": "test-admin-token"})
    assert r.status_code == 200, r.text
    # Le jeton ne quitte jamais le cookie httpOnly : les appels admin
    # suivants s'authentifient par le jar de cookies du TestClient.
    return eleve


@pytest.fixture()
def db():
    """Session SQLAlchemy sur la base de test, fermée après le test.

    À utiliser pour les assertions qui doivent lire l'état réel en base
    (lignes `epreuve_files`, `admin_lock`…), là où passer par l'API ne
    permet pas de vérifier une transaction annulée."""
    from app.db import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def epreuve_gratuite(admin):
    """Crée et publie une épreuve gratuite avec un sujet."""
    r = admin.post(
        "/api/admin/epreuves",
        json={
            "niveau": "SECONDAIRE",
            "classe": "terminale",
            "evaluation": "BAC",
            "matiere": "Mathématiques",
            "annee": "2024",
            "gratuit": True,
            "filieres": ["A", "C"],
            "contenu_markdown": "# Sujet test\n\nQuestion 1 : 2+2 ?",
        },
    )
    assert r.status_code == 200, r.text
    eid = r.json()["id"]
    r = admin.post(f"/api/admin/epreuves/{eid}/publish")
    assert r.status_code == 200, r.text
    return eid


# --------------------------------------------------------------------------
# Purge du catalogue
# --------------------------------------------------------------------------

# Tables d'identité et de session : les vider déconnecterait l'administrateur
# au milieu du test. Tout le reste est du contenu de catalogue et peut
# disparaître.
_TABLES_PRESERVEES = {
    "users",
    "sessions",
    "admin_lock",
    "admin_events",
    "kickout_notices",
    "referentiel_options",
}


def purger_catalogue(session) -> None:
    """Vide le catalogue, en respectant l'ordre des clés étrangères.

    La base de test est PARTAGÉE par tous les tests du projet. Chaque fichier
    qui a besoin d'un catalogue connu (export, restauration) doit donc vider
    les tables plutôt que faire confiance à l'état laissé par ses voisins.

    On énumère les tables depuis les métadonnées au lieu d'écrire une liste à la
    main : c'est exactement la liste figée qui devient fausse le jour où une
    table référence `epreuves` (une notification de publication, par exemple) —
    et le symptôme est alors un « FOREIGN KEY constraint failed » à trois
    fichiers d'ici. `reversed(sorted_tables)` donne les enfants avant les
    parents, donc aucune référence ne survit à la suppression de sa cible.
    """
    from sqlalchemy import text

    from app.db_models import Base

    for table in reversed(Base.metadata.sorted_tables):
        if table.name in _TABLES_PRESERVEES:
            continue
        session.execute(text(f'DELETE FROM "{table.name}"'))
    session.commit()


@pytest.fixture()
def epreuve_payante(admin):
    """Crée et publie une épreuve PAYANTE."""
    r = admin.post(
        "/api/admin/epreuves",
        json={
            "niveau": "SECONDAIRE",
            "classe": "terminale",
            "evaluation": "BAC",
            "matiere": "Physique-Chimie",
            "annee": "2024",
            "gratuit": False,
            "filieres": ["D"],
            "contenu_markdown": "# Sujet payant\n\nQuestion 1 ?",
        },
    )
    assert r.status_code == 200, r.text
    eid = r.json()["id"]
    r = admin.post(f"/api/admin/epreuves/{eid}/publish")
    assert r.status_code == 200, r.text
    return eid
