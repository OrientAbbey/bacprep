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
