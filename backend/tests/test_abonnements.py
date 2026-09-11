"""Abonnements : checkout → webhook → accès, annulation, cohérence entre
has_access (détail) et le filtre « ouvert » du catalogue (règle unifiée)."""
from __future__ import annotations


def test_checkout_webhook_active_acces(eleve, admin, epreuve_payante):
    r = eleve.post(
        "/api/subscriptions/checkout",
        json={"scope": "epreuve", "epreuve_id": epreuve_payante, "provider": "orange"},
    )
    assert r.status_code == 200, r.text
    ref = r.json()["reference_agregateur"]

    # L'abonnement n'est PAS actif avant confirmation
    r = eleve.get(f"/api/epreuves/{epreuve_payante}")
    assert r.status_code == 403

    # Le webhook d'un AUTRE utilisateur est refusé (avant : public !)
    from fastapi.testclient import TestClient
    import app.main as app_main

    with TestClient(app_main.app) as autre:
        autre.post("/api/auth/mock-login", json={"email": "autre@test.cm", "nom": "Autre"})
        r = autre.post(
            "/api/payments/simulate-webhook", json={"reference_agregateur": ref}
        )
        assert r.status_code == 404

    # Le webhook du propriétaire confirme
    r = eleve.post("/api/payments/simulate-webhook", json={"reference_agregateur": ref})
    assert r.status_code == 200 and not r.json()["already_confirmed"]

    # Idempotence : rejouer ne réactive rien de bizarre
    r = eleve.post("/api/payments/simulate-webhook", json={"reference_agregateur": ref})
    assert r.json()["already_confirmed"]

    # Accès accordé (session) ET visible « ouvert » dans le catalogue —
    # les deux dérivent désormais de la même règle (store.covered_...).
    assert eleve.get(f"/api/epreuves/{epreuve_payante}").status_code == 200
    r = eleve.get("/api/epreuves?acces_type=ouvert")
    assert epreuve_payante in [e["id"] for e in r.json()]


def test_annulation_revoque_acces(eleve, admin, epreuve_payante):
    r = eleve.post(
        "/api/subscriptions/checkout",
        json={"scope": "epreuve", "epreuve_id": epreuve_payante, "provider": "mtn"},
    )
    ref = r.json()["reference_agregateur"]
    eleve.post("/api/payments/simulate-webhook", json={"reference_agregateur": ref})
    sub_id = r.json()["subscription_id"]

    assert eleve.get(f"/api/epreuves/{epreuve_payante}").status_code == 200
    r = eleve.post(f"/api/subscriptions/{sub_id}/cancel")
    assert r.status_code == 200
    assert eleve.get(f"/api/epreuves/{epreuve_payante}").status_code == 403


def test_checkout_refuse_deja_couvert(eleve, admin, epreuve_gratuite):
    """Garde-fou serveur : pas de paiement pour du déjà-accessible."""
    r = eleve.post(
        "/api/subscriptions/checkout",
        json={"scope": "epreuve", "epreuve_id": epreuve_gratuite, "provider": "orange"},
    )
    assert r.status_code == 409


def test_provider_valide(eleve):
    r = eleve.post(
        "/api/subscriptions/checkout",
        json={"scope": "filiere", "filiere": "A", "classe": "terminale", "provider": "paypal"},
    )
    assert r.status_code == 422


def test_checkout_reutilise_payment_en_attente(eleve, epreuve_payante):
    """Le checkout d'une même sélection déjà en attente ne duplique pas les lignes."""
    body = {"scope": "epreuve", "epreuve_id": epreuve_payante, "provider": "orange"}
    r1 = eleve.post("/api/subscriptions/checkout", json=body)
    r2 = eleve.post("/api/subscriptions/checkout", json=body)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["reference_agregateur"] == r2.json()["reference_agregateur"]


def test_portee_plus_large_achetable_apres_abonnement_matiere(client):
    """Bug corrigé : un abonnement « matière » ne doit PAS bloquer l'achat
    d'une portée PLUS large (année, filière). Test isolé sur un utilisateur
    DÉDIÉ : la base est partagée entre tests, un abonnement "annee" actif
    laissé sur "eleve" invaliderait les tests suivants (checkout épreuve
    déjà couvert)."""
    from fastapi.testclient import TestClient
    import app.main as app_main

    with TestClient(app_main.app) as u:
        r = u.post("/api/auth/mock-login", json={"email": "scope-test@test.cm", "nom": "Scope Test"})
        assert r.status_code == 200, r.text

        r = u.post(
            "/api/subscriptions/checkout",
            json={"scope": "matiere", "filiere": "D", "classe": "terminale", "matiere": "Physique-Chimie", "provider": "orange"},
        )
        assert r.status_code == 200, r.text
        ref = r.json()["reference_agregateur"]
        assert u.post("/api/payments/simulate-webhook", json={"reference_agregateur": ref}).status_code == 200

        r = u.post(
            "/api/subscriptions/checkout",
            json={"scope": "annee", "filiere": "D", "classe": "terminale", "annee": "2024", "provider": "mtn"},
        )
        assert r.status_code == 200, r.text


def test_webhook_reel_exige_signature(eleve, epreuve_payante):
    """Webhook réel : signature invalide refusée, bonne signature active,
    rejeu idempotent, montant incohérent refusé."""
    import hashlib
    import hmac
    import os
    import time as time_mod

    r = eleve.post(
        "/api/subscriptions/checkout",
        json={"scope": "epreuve", "epreuve_id": epreuve_payante, "provider": "orange"},
    )
    ref = r.json()["reference_agregateur"]
    now = int(time_mod.time())
    montant = 400  # PRICING["epreuve"]

    def _signed(montant_v, ts):
        msg = f"orange|{ref}|{montant_v}|{ts}".encode()
        return hmac.new(os.environ["PAYMENT_WEBHOOK_SECRET"].encode(), msg, hashlib.sha256).hexdigest()

    # Signature invalide → 403
    r = eleve.post(
        "/api/payments/webhook",
        json={"provider": "orange", "reference_agregateur": ref, "montant": montant, "timestamp": now, "signature": "deadbeef"},
    )
    assert r.status_code == 403

    # Montant incohérent → 400
    r = eleve.post(
        "/api/payments/webhook",
        json={"provider": "orange", "reference_agregateur": ref, "montant": montant + 1, "timestamp": now, "signature": _signed(montant + 1, now)},
    )
    assert r.status_code == 400

    # Timestamp trop ancien → 400 (anti-replay)
    vieux = now - 600
    r = eleve.post(
        "/api/payments/webhook",
        json={"provider": "orange", "reference_agregateur": ref, "montant": montant, "timestamp": vieux, "signature": _signed(montant, vieux)},
    )
    assert r.status_code == 400

    # Signature valide → confirmation
    r = eleve.post(
        "/api/payments/webhook",
        json={"provider": "orange", "reference_agregateur": ref, "montant": montant, "timestamp": now, "signature": _signed(montant, now)},
    )
    assert r.status_code == 200 and not r.json()["already_confirmed"]
    assert eleve.get(f"/api/epreuves/{epreuve_payante}").status_code == 200

    # Rejeu → idempotent
    r = eleve.post(
        "/api/payments/webhook",
        json={"provider": "orange", "reference_agregateur": ref, "montant": montant, "timestamp": now, "signature": _signed(montant, now)},
    )
    assert r.status_code == 200 and r.json()["already_confirmed"]


def test_webhook_reel_refuse_sans_secret(eleve, epreuve_payante, monkeypatch):
    """Fail-closed : sans PAYMENT_WEBHOOK_SECRET configuré, pas de confirmation possible."""
    monkeypatch.setenv("ENV", "prod")
    monkeypatch.setenv("DEMO_MODE", "false")
    monkeypatch.delenv("PAYMENT_WEBHOOK_SECRET", raising=False)
    r = eleve.post(
        "/api/payments/webhook",
        json={"provider": "orange", "reference_agregateur": "whatever", "montant": 400, "timestamp": 0, "signature": ""},
    )
    assert r.status_code == 503
