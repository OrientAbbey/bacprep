"""Gouvernance des rôles admin : promotion/révocation par le ROOT
(ADMIN_ROOT) uniquement, et statut `is_admin` reflété dans la
table utilisateurs et `/api/auth/me`.

Le rôle vit dans `users.role` ("user"/"admin") : politiquement, un admin
promu est un utilisateur de plus — visible dans la table, bannissable et
supprimable une fois révoqué. Le ROOT, lui, est défini par la variable
d'environnement et reste intouchable (ni bann, ni suppression, ni
révocation par cette interface)."""
from __future__ import annotations

import app.main as app_main
from fastapi.testclient import TestClient


def test_promotion_admin_par_root_puis_revocation(client, admin):
    r = client.post("/api/auth/mock-login", json={"email": "membre@test.cm", "nom": "Membre"})
    assert r.status_code == 200
    uid = client.get("/api/auth/me").json()["id"]
    assert client.get("/api/auth/me").json()["is_admin"] is False

    # La table ne le montre pas admin ; le ROOT le promeut.
    rows = {u["email"]: u for u in admin.get("/api/admin/utilisateurs").json()}
    assert rows["membre@test.cm"]["is_admin"] is False
    assert admin.post(f"/api/admin/utilisateurs/{uid}/promouvoir").status_code == 200

    # Le compte est admis à la liste blanche admin (colonne rôle = liste
    # étendue de la variable d'environnement)...
    from app.core import admin_session
    from app.db import SessionLocal

    with SessionLocal() as db:
        assert "membre@test.cm" in admin_session.allowed_emails(db)
    # ...affiché admin dans la table... et reconnu dans /api/auth/me.
    rows = {u["email"]: u for u in admin.get("/api/admin/utilisateurs").json()}
    assert rows["membre@test.cm"]["is_admin"] is True
    assert rows["membre@test.cm"]["racine"] is False
    assert client.get("/api/auth/me").json()["is_admin"] is True

    # Révocation par le root → élève à nouveau, partout.
    assert admin.post(f"/api/admin/utilisateurs/{uid}/demouvoir").status_code == 200
    rows = {u["email"]: u for u in admin.get("/api/admin/utilisateurs").json()}
    assert rows["membre@test.cm"]["is_admin"] is False
    assert client.get("/api/auth/me").json()["is_admin"] is False


def test_seul_le_root_promouvoit(client, admin):
    # Un admin DÉLÉGUÉ ne peut ni promouvoir ni révoquer (périmètre ROOT).
    d = TestClient(app_main.app)
    assert d.post("/api/auth/mock-login", json={"email": "delegue@test.cm", "nom": "Délégué"}).status_code == 200
    delegate_id = d.get("/api/auth/me").json()["id"]
    assert admin.post(f"/api/admin/utilisateurs/{delegate_id}/promouvoir").status_code == 200

    assert client.post("/api/auth/mock-login", json={"email": "autre@test.cm", "nom": "Autre"}).status_code == 200
    autre_id = client.get("/api/auth/me").json()["id"]

    # Le ROOT délègue le verrou admin au délégué (force=true), qui tente.
    r = d.post("/api/admin/login", json={"email": "delegue@test.cm", "token": "test-admin-token", "force": True})
    assert r.status_code == 200, r.text
    assert d.post(f"/api/admin/utilisateurs/{autre_id}/promouvoir").status_code == 403
    assert d.post(f"/api/admin/utilisateurs/{delegate_id}/demouvoir").status_code == 403

    # Libération du verrou pour ne pas gêner les tests suivants.
    assert d.post("/api/admin/logout").status_code == 200


def test_root_intouchable(client, admin):
    from app.core import store
    from app.db import SessionLocal

    with SessionLocal() as db:
        root = store.get_or_create_user(db, "admin@example.com", "Admin Test")
        root_id = root.id
    assert admin.post(f"/api/admin/utilisateurs/{root_id}/demouvoir").status_code == 400
    assert admin.post(f"/api/admin/utilisateurs/{root_id}/bannir", json={}).status_code == 400
    assert admin.delete(f"/api/admin/utilisateurs/{root_id}").status_code == 400


def test_promotion_deja_admin_et_demotion_eleve(client, admin):
    from app.core import store
    from app.db import SessionLocal

    with SessionLocal() as db:
        membre = store.get_or_create_user(db, "deja@test.cm", "Déjà")
        membre_id = membre.id
    assert admin.post(f"/api/admin/utilisateurs/{membre_id}/demouvoir").status_code == 400
    assert admin.post(f"/api/admin/utilisateurs/{membre_id}/promouvoir").status_code == 200
    assert admin.post(f"/api/admin/utilisateurs/{membre_id}/promouvoir").status_code == 400


def test_utilisateurs_introuvable_promotion(client, admin):
    assert admin.post("/api/admin/utilisateurs/inconnu/promouvoir").status_code == 404
    assert admin.post("/api/admin/utilisateurs/inconnu/demouvoir").status_code == 404


def test_session_admin_par_cookie_httpoly(client):
    """Le parcours NAVIGATEUR : login posant le cookie httpOnly `admin_session`,
    puis routes admin appelées SANS en-tête X-Admin-Session (le frontend ne
    l'envoie plus) — le serveur doit lire le cookie. Régression du bug où la
    dépendance lisait un cookie inexistant `admin_session_cookie` (nom du
    paramètre au lieu de l'alias), renvoyant 401 après login."""
    c = TestClient(app_main.app)
    assert c.post("/api/auth/mock-login", json={"email": "root@example.com", "nom": "Admin Root"}).status_code == 200

    r = c.post("/api/admin/login", json={"email": "admin@example.com", "token": "test-admin-token"})
    assert r.status_code == 200, r.text
    assert "session_token" not in r.json()
    assert dict(c.cookies).get("admin_session")

    # Aucun en-tête X-Admin-Session : ces appels ne doivent PAS faire 401.
    assert c.get("/api/admin/stats").status_code == 200
    assert c.get("/api/admin/epreuves?limit=30").status_code == 200
    assert c.post("/api/admin/heartbeat").status_code == 200

    # Logout : le cookie et le verrou sont libérés → 401 ensuite.
    assert c.post("/api/admin/logout").status_code == 200
    assert c.get("/api/admin/stats").status_code == 401