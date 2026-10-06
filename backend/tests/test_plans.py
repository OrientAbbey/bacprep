"""Formules d'abonnement modifiables (table `plans`)."""
from __future__ import annotations


def test_pricing_lit_la_table_et_garde_la_compat(client):
    d = client.get("/api/pricing").json()
    assert len(d["plans"]) >= 5
    assert d["pricing"]["epreuve"] == 400 and d["duree_jours"] == 365


def test_crud_formules_admin(admin):
    r = admin.post("/api/admin/plans", json={
        "scope": "matiere", "libelle": "Matière 3 mois", "prix": 1200, "duree_jours": 90})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    assert admin.patch(f"/api/admin/plans/{pid}", json={"prix": 1300}).json()["prix"] == 1300
    assert any(p["id"] == pid for p in admin.get("/api/pricing").json()["plans"])
    assert admin.patch(f"/api/admin/plans/{pid}", json={"actif": False}).status_code == 200
    assert all(p["id"] != pid for p in admin.get("/api/pricing").json()["plans"])
    assert admin.delete(f"/api/admin/plans/{pid}").status_code == 200
    assert admin.delete(f"/api/admin/plans/{pid}").status_code == 404


def test_plan_invalide_refuse(admin):
    assert admin.post("/api/admin/plans", json={"scope": "x", "libelle": "a", "prix": 500, "duree_jours": 10}).status_code == 422
    assert admin.post("/api/admin/plans", json={"scope": "matiere", "libelle": "a", "prix": 5, "duree_jours": 10}).status_code == 422


def test_crud_formules_reserve_a_l_admin(eleve):
    assert eleve.get("/api/admin/plans").status_code in (401, 403)


def test_checkout_utilise_prix_et_duree_de_la_formule(admin):
    """Formule 'epreuve' dédiée (500 FCFA, 30 j), puis remise en l'état :
    la base de test est partagée entre les modules."""
    anciens = [p["id"] for p in admin.get("/api/admin/plans").json()["plans"] if p["scope"] == "epreuve" and p["actif"]]
    for i in anciens:
        admin.patch(f"/api/admin/plans/{i}", json={"actif": False})
    pid = admin.post("/api/admin/plans", json={
        "scope": "epreuve", "libelle": "Épreuve 30 j", "prix": 500, "duree_jours": 30}).json()["id"]
    try:
        eid = admin.post("/api/admin/epreuves", json={
            "niveau": "SECONDAIRE", "classe": "terminale", "evaluation": "BAC", "matiere": "Physique",
            "annee": "2023", "gratuit": False, "filieres": ["C"], "contenu_markdown": "# P"}).json()["id"]
        assert admin.post(f"/api/admin/epreuves/{eid}/publish").status_code == 200
        c = admin.post("/api/subscriptions/checkout", json={"scope": "epreuve", "epreuve_id": eid, "plan_id": pid})
        assert c.status_code == 200, c.text
        assert c.json()["montant"] == 500
        assert admin.post("/api/subscriptions/checkout", json={"scope": "epreuve", "epreuve_id": eid, "plan_id": "inconnu"}).status_code == 400
    finally:
        admin.delete(f"/api/admin/plans/{pid}")
        for i in anciens:
            admin.patch(f"/api/admin/plans/{i}", json={"actif": True})


def test_nouvelle_formule_placee_en_dernier(admin):
    avant = [p["id"] for p in admin.get("/api/admin/plans").json()["plans"]]
    pid = admin.post("/api/admin/plans", json={"scope": "annee", "libelle": "Dernière", "prix": 150, "duree_jours": 30}).json()["id"]
    try:
        apres = [p["id"] for p in admin.get("/api/admin/plans").json()["plans"]]
        assert apres[-1] == pid and apres[:-1] == avant  # ni insérée au milieu, ni réordonnant les autres
        pid2 = admin.post("/api/admin/plans", json={"scope": "annee", "libelle": "Encore", "prix": 100, "duree_jours": 30}).json()["id"]
        assert [p["id"] for p in admin.get("/api/admin/plans").json()["plans"]][-2:] == [pid, pid2]
        admin.delete(f"/api/admin/plans/{pid2}")
    finally:
        admin.delete(f"/api/admin/plans/{pid}")
