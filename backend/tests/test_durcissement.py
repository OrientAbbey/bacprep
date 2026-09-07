"""Durcissement 2026-09 (revue sécurité) : garde DEMO_MODE sur les
fonctionnalités de démo, headers de sécurité, expiration + hash des
sessions, paywall des images de l'assistant, validation des images
uploadées, rate limit des logins, bornes des entrées assistant."""
from __future__ import annotations

from datetime import timedelta
from io import BytesIO

from PIL import Image


def _png_bytes() -> bytes:
    """PNG valide au contenu unique (pixels aléatoires) : la détection de
    doublons par checksum ne doit pas croiser les uploads d'autres tests."""
    import os as _os

    buf = BytesIO()
    Image.frombytes("RGB", (8, 8), _os.urandom(8 * 8 * 3)).save(buf, format="PNG")
    return buf.getvalue()


# ---------- DEMO_MODE : mock-login & simulate-webhook ----------

def test_mock_login_refuse_en_prod_sans_demo_mode(client, monkeypatch):
    """En production, la connexion simulée (aucune preuve de possession)
    est refusée sauf DEMO_MODE=true explicite."""
    monkeypatch.setenv("ENV", "prod")
    monkeypatch.delenv("DEMO_MODE", raising=False)
    r = client.post("/api/auth/mock-login", json={"email": "x@test.cm", "nom": "X"})
    assert r.status_code == 403


def test_mock_login_autorise_en_prod_avec_demo_mode(client, monkeypatch):
    monkeypatch.setenv("ENV", "prod")
    monkeypatch.setenv("DEMO_MODE", "true")
    r = client.post("/api/auth/mock-login", json={"email": "demo@test.cm", "nom": "Démo"})
    assert r.status_code == 200


def test_simulate_webhook_refuse_en_prod_sans_demo_mode(eleve, monkeypatch):
    """Même authentifié, l'utilisateur connaît la référence (reçue au
    checkout) : sans DEMO_MODE, la simulation de paiement est fermée en
    production — sinon auto-abonnement gratuit."""
    monkeypatch.setenv("ENV", "prod")
    monkeypatch.delenv("DEMO_MODE", raising=False)
    r = eleve.post("/api/payments/simulate-webhook", json={"reference_agregateur": "SIMULATED-x"})
    assert r.status_code == 403


def test_simulate_webhook_ok_en_dev(eleve, admin, epreuve_payante):
    """Hors production, la démo reste fonctionnelle : checkout puis webhook
    activent bien l'abonnement (garde-fou demo_allowed ne s'applique pas)."""
    r = eleve.post("/api/subscriptions/checkout", json={"scope": "epreuve", "epreuve_id": epreuve_payante})
    assert r.status_code == 200, r.text
    reference = r.json()["reference_agregateur"]
    r = eleve.post("/api/payments/simulate-webhook", json={"reference_agregateur": reference})
    assert r.status_code == 200
    assert r.json()["already_confirmed"] is False


# ---------- Headers de sécurité ----------

def test_headers_securites_sur_api(client):
    r = client.get("/api/health")
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"


# ---------- Sessions : expiration + hash ----------

def test_session_expiree_refusee(eleve, monkeypatch):
    """L'expiration doit être vérifiée : une session au-delà du délai est
    refusée et purgée. Depuis la revue sécurité, l'expiration est GLISSANTE
    (SESSION_TTL_GLISSANT, inactivité) bornée par une durée maximale absolue
    (SESSION_TTL_MAX) — le test patche le délai glissant à zéro."""
    from app.core import store

    monkeypatch.setattr(store, "SESSION_TTL_GLISSANT", timedelta(0))
    r = eleve.get("/api/auth/me")
    assert r.status_code == 401


def test_session_duree_maximale_absolue(eleve, monkeypatch):
    """Même avec une activité récente (last_seen à maintenant), une session
    émise il y a plus de SESSION_TTL_MAX est refusée — la borne absolue
    prime sur le glissement."""
    from datetime import timedelta as td

    from app.core import store
    from app.db import SessionLocal, utc_now
    from app.db_models import SessionORM, UserORM

    me = eleve.get("/api/auth/me").json()
    with SessionLocal() as db:
        uid = db.query(UserORM).filter(UserORM.email == me["email"]).one().id
        s = db.query(SessionORM).filter(SessionORM.user_id == uid).one()
        s.issued_at = utc_now() - td(days=15)  # au-delà du maximum (14 j)
        s.last_seen = utc_now()  # ...mais active à l'instant
        db.commit()
    assert eleve.get("/api/auth/me").status_code == 401


def test_token_session_stocke_hashe(eleve):
    """Seul le SHA-256 du jeton part en base (64 hex) — jamais le jeton
    lui-même (32 hex)."""
    from app.db import SessionLocal
    from app.db_models import SessionORM

    db = SessionLocal()
    try:
        tokens = [s.token for s in db.query(SessionORM).all()]
    finally:
        db.close()
    assert tokens, "au moins une session doit exister"
    assert all(len(t) == 64 for t in tokens)


# ---------- Rate limit des logins ----------

def test_rate_limit_login_etudiant(client, monkeypatch):
    """Sans LOGIN_RATE_LIMIT=0, la 11e connexion depuis la même IP dans la
    fenêtre est rejetée (429)."""
    monkeypatch.delenv("LOGIN_RATE_LIMIT", raising=False)
    from app.routers.auth import _login_limiter

    _login_limiter.reset()
    statuts = []
    for i in range(11):
        r = client.post("/api/auth/mock-login", json={"email": f"rl{i}@test.cm", "nom": "RL"})
        statuts.append(r.status_code)
    _login_limiter.reset()
    assert statuts[-1] == 429
    assert all(s == 200 for s in statuts[:-1])


# ---------- Assistant : paywall images + bornes ----------

def test_assistant_ignore_image_paywalled(admin, eleve, epreuve_payante):
    """Le contexte des discussions est rédigé par le client : une image
    d'une épreuve payante ne doit jamais atteindre le LLM d'un utilisateur
    sans abonnement (contournement du paywall)."""
    from app.core.assistant import _fetch_image_row
    from app.db import SessionLocal

    r = admin.post(
        f"/api/admin/epreuves/{epreuve_payante}/images",
        data={"cible": "sujet"},
        files={"file": ("figure.png", _png_bytes(), "image/png")},
    )
    assert r.status_code == 200, r.text
    file_id = r.json()["id"]

    user_id = eleve.get("/api/auth/me").json()["id"]
    db = SessionLocal()
    try:
        assert _fetch_image_row(file_id, user_id) is None  # paywall : ignorée
    finally:
        db.close()


def test_assistant_sert_image_gratuite(admin, eleve, epreuve_gratuite):
    """Contrôle positif : même utilisateur, image d'une épreuve gratuite →
    l'image est bien retrouvée."""
    from app.core.assistant import _fetch_image_row
    from app.db import SessionLocal

    r = admin.post(
        f"/api/admin/epreuves/{epreuve_gratuite}/images",
        data={"cible": "sujet"},
        files={"file": ("figure.png", _png_bytes(), "image/png")},
    )
    assert r.status_code == 200, r.text
    file_id = r.json()["id"]

    user_id = eleve.get("/api/auth/me").json()["id"]
    db = SessionLocal()
    try:
        assert _fetch_image_row(file_id, user_id) is not None
    finally:
        db.close()


def test_askin_message_trop_long_refuse(eleve, epreuve_gratuite):
    """Borne LLM05/LLM10 : la question est plafonnée (422 sinon)."""
    r = eleve.post(
        f"/api/epreuves/{epreuve_gratuite}/conversations",
        json={"contexte": "", "label": "T"},
    )
    assert r.status_code == 200, r.text
    conv_id = r.json()["id"]
    r = eleve.post(
        "/api/assistant/ask",
        json={"conversation_id": conv_id, "message": "a" * 4001},
    )
    assert r.status_code == 422


# ---------- Upload d'images : validation du contenu ----------

def test_upload_image_invalide_415(admin, epreuve_gratuite):
    """Un fichier non-image déguisé en image/png est refusé (415) — le
    contenu est vérifié via les magic bytes, pas le Content-Type client ;
    plus aucun repli sur le stockage des octets bruts."""
    r = admin.post(
        f"/api/admin/epreuves/{epreuve_gratuite}/images",
        data={"cible": "sujet"},
        files={"file": ("faux.png", b"<html><script>alert(1)</script></html>", "image/png")},
    )
    assert r.status_code == 415


def test_upload_image_valide_ok(admin, epreuve_gratuite):
    r = admin.post(
        f"/api/admin/epreuves/{epreuve_gratuite}/images",
        data={"cible": "sujet"},
        files={"file": ("figure.png", _png_bytes(), "image/png")},
    )
    assert r.status_code == 200
    assert r.json()["url"].startswith("/api/files/")
