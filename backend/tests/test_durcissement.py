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


def test_client_ip_privilegie_entree_xff_de_droite(monkeypatch):
    """L'entrée XFF la plus à gauche est choisie par l'attaquant : le
    compteur doit retenir celle de droite (ajoutée par le proxy), sinon le
    quota se contourne en forgeant l'en-tête."""
    from starlette.requests import Request

    from app.core.rate_limit import client_ip

    monkeypatch.setenv("ENV", "prod")

    def _requete(headers, host="10.0.0.1"):
        return Request(
            {
                "type": "http",
                "method": "GET",
                "path": "/",
                "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
                "client": (host, 1234),
            }
        )

    # Forgé à gauche, IP réelle à droite → c'est celle de droite qui compte.
    r = _requete({"x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.10.11.12"})
    assert client_ip(r) == "9.10.11.12"

    # Un en-tête entièrement falsifié reste pris tel quel en dernier recours :
    # au moins la clé est-elle bien normalisée et non le texte brut ?
    r = _requete({"x-forwarded-for": "1.2.3.4, 5.6.7.8"})
    assert client_ip(r) == "5.6.7.8"

    # En-têtes de bord prioritaires, et validés comme IP.
    r = _requete({"true-client-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4"})
    assert client_ip(r) == "203.0.113.7"
    r = _requete({"cf-connecting-ip": "203.0.113.8"})
    assert client_ip(r) == "203.0.113.8"

    # Valeur non-IP : on l'ignore et on passe à la suite, sinon un en-tête
    # fourré de texte ferait exploser la cardinalité des compteurs.
    r = _requete({"true-client-ip": "pas-une-ip", "x-forwarded-for": "nawak, 203.0.113.9"})
    assert client_ip(r) == "203.0.113.9"

    # Rien d'exploitable → repli sur l'IP socket du proxy.
    r = _requete({"x-forwarded-for": "pourriel"}, host="198.51.100.4")
    assert client_ip(r) == "198.51.100.4"


def test_client_ip_ignore_entetes_de_bord_hors_production(monkeypatch):
    """Hors production, seul le client socket fait foi : les en-têtes de
    bord sont ignorés (et le test de session ne dépend pas d'un proxy)."""
    from starlette.requests import Request

    from app.core.rate_limit import client_ip

    monkeypatch.setenv("ENV", "dev")
    r = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": [(b"x-forwarded-for", b"1.2.3.4")],
            "client": ("127.0.0.1", 1234),
        }
    )
    assert client_ip(r) == "127.0.0.1"


def test_rate_limiter_memoire_bornee():
    """Une rotation d'IP ne doit pas faire croître le dictionnaire sans
    borne : au-delà de MAX_TRACKED_KEYS, les entrées les plus anciennes
    sont évictées."""
    from app.core.rate_limit import MAX_TRACKED_KEYS, SlidingWindowLimiter

    lim = SlidingWindowLimiter(max_attempts=5, window_seconds=3600)
    pic = 0
    for i in range(MAX_TRACKED_KEYS + 2000):
        lim.check(f"10.{(i // 256) % 256}.{i % 256}")
        pic = max(pic, len(lim._attempts))
    assert pic <= MAX_TRACKED_KEYS, f"mémoire non bornée : {pic} clés"
    lim.reset()
    assert lim._attempts == {}


def test_rate_limiter_purge_les_cles_hors_fenetre(monkeypatch):
    """Une IP jamais revisitée ne doit pas conserver ses horodatages
    indéfiniment. Le balayage est déclenché à mi-capacité (coût amorté),
    pas à chaque appel : le seuil est donc abaissé pour l'exercer."""
    import time as _time

    from app.core import rate_limit
    from app.core.rate_limit import SlidingWindowLimiter

    # Purge à partir de 100 clés (mi-capacité de 200), éviction à 200.
    monkeypatch.setattr(rate_limit, "MAX_TRACKED_KEYS", 200)
    lim = SlidingWindowLimiter(max_attempts=5, window_seconds=0.05)

    for i in range(60):
        lim.check(f"192.168.1.{i}")
    assert len(lim._attempts) == 60
    # Exactement au seuil (mi-capacité de 200) : le prochain appel purge.
    for i in range(40):
        lim.check(f"192.168.2.{i}")
    assert len(lim._attempts) == 100

    # Fenêtre écoulée, puis nouvel appel : le seuil est franchi, les 100
    # entrées sont périmées et le dictionnaire se vide entièrement.
    _time.sleep(0.08)
    lim.check("192.168.3.1")
    assert list(lim._attempts) == ["192.168.3.1"]


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
