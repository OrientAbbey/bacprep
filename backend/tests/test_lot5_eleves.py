"""Lot 5 — calendrier, examens blancs (essais) et révision espacée."""
from __future__ import annotations

from datetime import timedelta

from app.db import SessionLocal, utc_now
from app.db_models import EssaiORM
from app.routers.essais import intervalle_jours


def test_calendrier_crud_et_lecture_publique(admin, client):
    r = admin.post("/api/admin/evenements", json={"titre": "Probatoire (test)", "type": "examen", "evaluation": "PROBATOIRE", "date_debut": "2027-06-01"})
    assert r.status_code == 200, r.text
    eid = r.json()["id"]
    assert any(e["id"] == eid for e in client.get("/api/calendrier").json())
    assert admin.patch(f"/api/admin/evenements/{eid}", json={"visible": False}).status_code == 200
    assert all(e["id"] != eid for e in client.get("/api/calendrier").json())  # masqué au public
    assert any(e["id"] == eid for e in admin.get("/api/admin/evenements").json())
    assert admin.delete(f"/api/admin/evenements/{eid}").status_code == 200
    assert admin.delete(f"/api/admin/evenements/{eid}").status_code == 404


def test_calendrier_validation(admin):
    ko = {"titre": "x", "date_debut": "01/06/2027"}
    assert admin.post("/api/admin/evenements", json=ko).status_code == 422
    assert admin.post("/api/admin/evenements", json={"titre": "x", "date_debut": "2027-06-01", "lien_officiel": "javascript:alert(1)"}).status_code == 422


def test_calendrier_ecriture_reservee_a_l_admin(eleve):
    assert eleve.post("/api/admin/evenements", json={"titre": "x", "date_debut": "2027-06-01"}).status_code in (401, 403)


def test_intervalles_de_revision():
    assert intervalle_jours(5, 1) == 1 and intervalle_jours(12, 1) == 3
    assert intervalle_jours(15, 1) == 7 and intervalle_jours(18, 1) == 14 and intervalle_jours(18, 3) == 30
    assert intervalle_jours(None, 1) == 3


def test_essai_historique_et_moyennes(eleve, epreuve_gratuite):
    for note in (10, 14):
        assert eleve.post("/api/me/essais", json={"epreuve_id": epreuve_gratuite, "note": note, "duree_s": 3600}).status_code == 200
    h = eleve.get("/api/me/essais").json()
    assert [e["note"] for e in h["essais"][:2]] == [14, 10]
    assert any(m["moyenne"] == 12.0 and m["essais"] == 2 for m in h["moyennes"])


def test_essai_valide_la_note_et_l_acces(eleve, epreuve_gratuite, epreuve_payante):
    assert eleve.post("/api/me/essais", json={"epreuve_id": epreuve_gratuite, "note": 25}).status_code == 422
    assert eleve.post("/api/me/essais", json={"epreuve_id": epreuve_payante, "note": 12}).status_code == 403  # pas d'abonnement
    assert eleve.post("/api/me/essais", json={"epreuve_id": "inconnue", "note": 12}).status_code == 404


def test_revisions_calculees_depuis_les_essais(eleve, epreuve_gratuite):
    uid = eleve.get("/api/auth/me").json()["id"]
    assert eleve.post("/api/me/essais", json={"epreuve_id": epreuve_gratuite, "note": 8}).status_code == 200
    assert eleve.get("/api/me/revisions").json() == []  # note 8 → échéance dans 1 jour : pas encore due
    with SessionLocal() as db:  # on recule le dernier essai de 2 jours
        e = db.query(EssaiORM).filter(EssaiORM.user_id == uid).order_by(EssaiORM.created_at.desc()).first()
        e.created_at = utc_now() - timedelta(days=2)
        db.commit()
    dues = eleve.get("/api/me/revisions").json()
    assert dues and dues[0]["epreuve_id"] == epreuve_gratuite and dues[0]["retard_jours"] >= 1
    assert eleve.post("/api/me/essais", json={"epreuve_id": epreuve_gratuite, "note": 17}).status_code == 200  # revue : plus due
    assert all(d["epreuve_id"] != epreuve_gratuite for d in eleve.get("/api/me/revisions").json())


def test_suppression_de_compte_efface_les_essais_et_l_export_les_contient(eleve, epreuve_gratuite):
    assert eleve.post("/api/me/essais", json={"epreuve_id": epreuve_gratuite, "note": 11}).status_code == 200
    export = eleve.get("/api/me/export").json()
    assert any(e["note"] == 11 for e in export["essais"])
    assert eleve.delete("/api/me/compte").status_code == 200  # échouait en FK avant la purge des essais
