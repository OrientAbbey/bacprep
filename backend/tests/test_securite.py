"""Sécurité : catch-all SPA confiné, mock-login gardé, webhook payé,
jetons signés. (Le test « catalogue anonyme » qui aurait attrapé le
NameError historique vit dans test_catalogue.py.)"""
from __future__ import annotations

import time

from app.core import signing


def test_health_sans_details_config(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}  # plus d'env_file_found


def test_catch_all_ne_sert_pas_hors_dist(client):
    """Path traversal corrigé : un chemin ../ ne doit JAMAIS sortir de
    frontend/dist (le .env contient ADMIN_TOKEN, clés LLM...)."""
    for path in (
        "/../../backend/.env",
        "/..%2f..%2fbackend/.env",
        "/....//backend/.env",
        "/%2e%2e/%2e%2e/backend/.env",
    ):
        r = client.get(path, follow_redirects=False)
        if r.status_code == 200:
            # 200 n'est acceptable que si ce n'est PAS le .env (index.html)
            assert b"ADMIN_TOKEN" not in r.content, f"fuite via {path}"


def test_api_inconnue_repond_404_json(client):
    r = client.get("/api/nimporte/quoi")
    assert r.status_code == 404
    assert "detail" in r.json()


def test_fichier_inexistant_404(client):
    assert client.get("/api/files/id-inexistant").status_code == 404


def test_jetons_signesExpiration_et_altération():
    token, expires = signing.sign_file_id("abc123", epreuve_id="ep1", statut="publie", max_age_seconds=60)
    assert signing.verify_file_token("abc123", "ep1", "publie", token)
    assert not signing.verify_file_token("abc123", "ep1", "brouillon", token)  # statut différent → révoqué
    assert not signing.verify_file_token("abc123", "ep-autre", "publie", token)  # autre épreuve
    assert not signing.verify_file_token("autre-id", "ep1", "publie", token)  # autre fichier
    # jeton expiré (grâce 5 min dépassée)
    expires_passe = int(time.time()) - 600
    import hashlib
    import hmac as hmac_mod

    digest = hmac_mod.new(
        signing._secret(), f"ep1.publie.abc123.{expires_passe}".encode(), hashlib.sha256
    ).hexdigest()
    assert not signing.verify_file_token("abc123", "ep1", "publie", f"{expires_passe}.{digest}")
    assert not signing.verify_file_token("abc123", "ep1", "publie", "garbage")


def test_simulate_webhook_exige_session(client):
    """Avant correctif : endpoint PUBLIC — on pouvait activer un abonnement
    avec la seule référence retournée au checkout."""
    r = client.post("/api/payments/simulate-webhook", json={"reference_agregateur": "SIMULATED-x"})
    assert r.status_code in (401, 403)


def test_mock_login_desactive_en_mode_google(client, monkeypatch):
    """Avant correctif : /mock-login restait actif même en AUTH_MODE=google
    → prise de contrôle de n'importe quel compte par email."""
    monkeypatch.setenv("AUTH_MODE", "google")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "xxx.apps.googleusercontent.com")
    r = client.post("/api/auth/mock-login", json={"email": "victime@test.cm", "nom": "V"})
    assert r.status_code == 403


def test_kickout_notice_exige_session(client, eleve):
    r = client.get("/api/auth/kickout-notice/quelconque")
    assert r.status_code in (401, 403)


def test_admin_login_jeton_manquant_refuse(client, monkeypatch):
    monkeypatch.delenv("ADMIN_TOKEN", raising=False)
    r = client.post("/api/admin/login", json={"email": "admin@example.com", "token": "x"})
    assert r.status_code == 500  # fail-closed, message explicite
