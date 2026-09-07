"""Fixtures pytest : app FastAPI sur SQLite temporaire, env posé AVANT
l'import d'app.main (inspiré de scripts_dev/smoke_v4.py, mais collectable
par pytest)."""
from __future__ import annotations

import os
import tempfile

# Env à positionner avant tout import d'app.* (les modules lisent os.getenv
# à l'import pour certains réglages).
_TMP = tempfile.mkdtemp(prefix="bacprep_test_")
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
os.environ["FILE_URL_SECRET"] = "t" * 32
os.environ["ADMIN_TOKEN"] = "test-admin-token"
os.environ["ADMIN_EMAILS"] = "admin@example.com"
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
    """Client élève AYANT AUSSI une session admin (en-tête X-Admin-Session)."""
    r = eleve.post("/api/admin/login", json={"email": "admin@example.com", "token": "test-admin-token"})
    assert r.status_code == 200, r.text
    token = r.json()["session_token"]
    eleve.headers = {**eleve.headers, "X-Admin-Session": token}
    return eleve


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
