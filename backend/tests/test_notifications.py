"""Notifications (cloche élève + gestion back-office).

La base de test est partagée entre toutes les suites (même sqlite temporaire)
et la publication d'épreuves crée des notifications « nouvelle épreuve » en
arrière-plan : chaque test vide donc la table d'abord pour rester isolé et
indépendant de l'ordre d'exécution.
"""
from __future__ import annotations


def _vider_notifications(admin):
    for n in admin.get("/api/admin/notifications").json():
        admin.delete(f"/api/admin/notifications/{n['id']}")


def _creer_notification(admin, titre="Nouvelle épreuve", epreuve_id=None, actif=True, **extra):
    payload = {"titre": titre, "message": "Détail du message", "type": "information",
               "actif": actif, "epreuve_id": epreuve_id, **extra}
    r = admin.post("/api/admin/notifications", json=payload)
    assert r.status_code == 200, r.text
    return r.json()


def test_visiteur_non_authentifie(visiteur):
    r = visiteur.get("/api/notifications")
    assert r.status_code == 401


def test_liste_actives_avec_compteur(admin, eleve):
    _vider_notifications(admin)
    _creer_notification(admin, titre="Notif 1", type="nouvelle_epreuve")
    _creer_notification(admin, titre="Notif inactive", actif=False)
    r = eleve.get("/api/notifications")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["non_lues"] == 1
    assert len(data["items"]) == 1
    n = data["items"][0]
    assert n["titre"] == "Notif 1"
    assert n["type"] == "nouvelle_epreuve"
    assert n["lue"] is False


def test_marquer_lue_idempotent(admin, eleve):
    _vider_notifications(admin)
    n = _creer_notification(admin)
    nid = n["id"]
    assert eleve.post(f"/api/notifications/{nid}/lue").status_code == 200
    assert eleve.post(f"/api/notifications/{nid}/lue").status_code == 200
    data = eleve.get("/api/notifications").json()
    assert data["non_lues"] == 0
    assert data["items"][0]["lue"] is True


def test_marquer_lue_notif_inactive_404(admin, eleve):
    _vider_notifications(admin)
    n = _creer_notification(admin, actif=False)
    r = eleve.post(f"/api/notifications/{n['id']}/lue")
    assert r.status_code == 404


def test_tout_marquer_lue(admin, eleve):
    _vider_notifications(admin)
    _creer_notification(admin, titre="A")
    _creer_notification(admin, titre="B")
    assert eleve.get("/api/notifications").json()["non_lues"] == 2
    assert eleve.post("/api/notifications/lues").status_code == 200
    assert eleve.get("/api/notifications").json()["non_lues"] == 0


def test_admin_crud_complet(admin):
    _vider_notifications(admin)
    n = _creer_notification(admin, titre="Avant", message="msg", actif=True)
    nid = n["id"]
    r = admin.put(f"/api/admin/notifications/{nid}", json={"titre": "Après", "actif": False})
    assert r.status_code == 200, r.text
    assert r.json()["titre"] == "Après"
    assert r.json()["actif"] is False
    r = admin.post(f"/api/admin/notifications/{nid}/toggle")
    assert r.status_code == 200 and r.json()["actif"] is True
    r = admin.get("/api/admin/notifications")
    assert r.status_code == 200 and len(r.json()) == 1
    assert admin.delete(f"/api/admin/notifications/{nid}").status_code == 200
    assert admin.get("/api/admin/notifications").json() == []


def test_notification_liee_a_epreuve(admin, eleve, epreuve_gratuite):
    _vider_notifications(admin)
    _creer_notification(admin, titre="Accédez à l'épreuve", epreuve_id=epreuve_gratuite)
    data = eleve.get("/api/notifications").json()
    assert data["items"][0]["epreuve_id"] == epreuve_gratuite


def test_publication_epreuve_cree_notification(admin, eleve):
    _vider_notifications(admin)
    r = admin.post("/api/admin/epreuves", json={
        "niveau": "SECONDAIRE", "classe": "terminale", "evaluation": "BAC",
        "matiere": "Histoire", "annee": "2023", "gratuit": True,
        "filieres": ["A"], "contenu_markdown": "# Sujet histoire",
    })
    eid = r.json()["id"]
    assert admin.post(f"/api/admin/epreuves/{eid}/publish").status_code == 200
    data = eleve.get("/api/notifications").json()
    proches = [n for n in data["items"] if n["type"] == "nouvelle_epreuve"]
    assert len(proches) == 1
    assert proches[0]["epreuve_id"] == eid


def test_purge_lectures_suppression_compte(admin, eleve):
    _vider_notifications(admin)
    n = _creer_notification(admin)
    eleve.post(f"/api/notifications/{n['id']}/lue")
    email = eleve.get("/api/auth/me").json()["email"]
    assert eleve.delete("/api/me/compte").status_code == 200
    # après recréation du même élève, la lecture a disparu (effacement strict)
    r = admin.post("/api/auth/mock-login", json={"email": email, "nom": "Revenu"})
    assert r.status_code == 200, r.text
    assert admin.get("/api/notifications").json()["non_lues"] == 1


def test_admin_creer_notification_sans_titre_422(admin):
    _vider_notifications(admin)
    r = admin.post("/api/admin/notifications", json={"titre": ""})
    assert r.status_code == 422


def test_admin_suppression_epreuve_n_affecte_pas_notifications(admin, eleve, epreuve_gratuite):
    _vider_notifications(admin)
    _creer_notification(admin, epreuve_id=epreuve_gratuite)
    assert admin.delete(f"/api/admin/epreuves/{epreuve_gratuite}").status_code == 200
    assert len(admin.get("/api/admin/notifications").json()) == 1