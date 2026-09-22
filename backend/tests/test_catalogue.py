"""Catalogue public : le filtre acces_type=ouvert sans session doit
répondre 200 (le NameError historique — sqlalchemy.false() — renvoyait
un 500), et les épreuves gratuites/payantes se comportent correctement."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app.main as app_main


@pytest.fixture()
def anonyme():
    """Client réellement SANS session (la fixture `client` du conftest peut
    avoir reçu un cookie mock-login via les fixtures admin/eleve dérivées)."""
    with TestClient(app_main.app) as c:
        yield c


def test_acces_type_ouvert_anonyme_200(anonyme, epreuve_gratuite, epreuve_payante):
    """« Ouvert » = payantes DÉJÀ couvertes par un abonnement actif.
    Anonyme : rien n'est couvert — la route doit répondre 200 et une liste
    vide (500 NameError avant correction de sql_false())."""
    r = anonyme.get("/api/epreuves?acces_type=ouvert")
    assert r.status_code == 200, r.text
    ids = [e["id"] for e in r.json()]
    assert epreuve_payante not in ids
    assert epreuve_gratuite not in ids


def test_acces_type_ouvert_connecte(eleve, admin, epreuve_payante):
    """Avec une session : une épreuve payante couverte apparaît."""
    r = eleve.get("/api/epreuves?acces_type=ouvert")
    assert epreuve_payante not in [e["id"] for e in r.json()]  # rien acheté
    r = eleve.post(
        "/api/subscriptions/checkout",
        json={"scope": "epreuve", "epreuve_id": epreuve_payante, "provider": "orange"},
    )
    ref = r.json()["reference_agregateur"]
    eleve.post("/api/payments/simulate-webhook", json={"reference_agregateur": ref})
    r = eleve.get("/api/epreuves?acces_type=ouvert")
    assert epreuve_payante in [e["id"] for e in r.json()]


def test_acces_type_gratuit(client, epreuve_gratuite, epreuve_payante):
    r = client.get("/api/epreuves?acces_type=gratuit")
    assert r.status_code == 200
    ids = [e["id"] for e in r.json()]
    assert epreuve_gratuite in ids
    assert epreuve_payante not in ids


def test_catalogue_public_ne_montre_que_publie(client, admin):
    admin.post(
        "/api/admin/epreuves",
        json={
            "niveau": "SECONDAIRE",
            "classe": "terminale",
            "evaluation": "BAC",
            "matiere": "Histoire",
            "annee": "2023",
            "filieres": ["A"],
            "contenu_markdown": "brouillon non publié",
        },
    )
    r = client.get("/api/epreuves?classe=terminale")
    assert r.status_code == 200
    assert all(e["statut"] == "publie" for e in r.json())


def test_navigation_publique(client, epreuve_gratuite):
    r = client.get("/api/epreuves/navigation")
    assert r.status_code == 200
    niveaux = {n["code"]: n for n in r.json()["niveaux"]}
    terminale = next(c for c in niveaux["SECONDAIRE"]["classes"] if c["code"] == "terminale")
    assert terminale["epreuves"] >= 1
    assert terminale["actif"]


def test_navigation_primaire_inactif_zero_epreuve(client, epreuve_gratuite):
    """La carte PRIMAIRE (réservée) ne doit JAMAIS afficher les comptages
    du secondaire : aucune classe, aucun total — le frontend additionne
    `classes[].epreuves` pour le compteur de la carte niveau."""
    r = client.get("/api/epreuves/navigation")
    assert r.status_code == 200
    niveaux = {n["code"]: n for n in r.json()["niveaux"]}
    primaire = niveaux["PRIMAIRE"]
    assert primaire["actif"] is False
    assert primaire["classes"] == []
    assert sum(c["epreuves"] for c in primaire["classes"]) == 0
