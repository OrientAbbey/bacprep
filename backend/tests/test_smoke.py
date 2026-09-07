"""Scénarios repris de scripts_dev/smoke_v4.py, collectables par pytest :
notes, signalements, profil, activité, historique."""
from __future__ import annotations


def test_profil_et_infos_etendues(eleve):
    r = eleve.put("/api/me/profil", json={"nom": "Élève Renommé", "niveau": "SECONDAIRE", "classe": "terminale"})
    assert r.status_code == 200
    p = eleve.get("/api/me/profil").json()
    assert p["nom"] == "Élève Renommé"
    assert p["classe"] == "terminale"


def test_notes_crud(eleve, epreuve_gratuite):
    eleve.get(f"/api/epreuves/{epreuve_gratuite}")  # consultation
    r = eleve.post(f"/api/epreuves/{epreuve_gratuite}/notes", json={"cible": "sujet", "contenu": "Ma note", "contexte_extrait": "Question 1"})
    if r.status_code == 404:
        # endpoint de création différent — passer par PUT générique impossible :
        # la création se fait via POST notes (contrat v3)
        raise AssertionError(r.text)
    note = r.json()
    nid = note["id"]
    r = eleve.put(f"/api/me/notes/{nid}", json={"contenu": "Note modifiée"})
    assert r.status_code == 200 and r.json()["contenu"] == "Note modifiée"
    notes = eleve.get("/api/me/notes").json()
    assert any(n["id"] == nid for n in notes)
    assert eleve.delete(f"/api/me/notes/{nid}").status_code == 200
    assert all(n["id"] != nid for n in eleve.get("/api/me/notes").json())


def test_signalements_flux_complet(eleve, admin, epreuve_gratuite):
    r = eleve.post(
        f"/api/epreuves/{epreuve_gratuite}/signalements",
        json={"motif": "image_cassee", "message": "figure absente"},
    )
    assert r.status_code in (200, 201), r.text
    # anti-doublon : même motif encore ouvert → 409
    r2 = eleve.post(
        f"/api/epreuves/{epreuve_gratuite}/signalements",
        json={"motif": "image_cassee", "message": "toujours absente"},
    )
    assert r2.status_code == 409
    liste = admin.get("/api/admin/signalements").json()
    assert any(s["motif"] == "image_cassee" for s in liste)
    sid = next(s["id"] for s in liste if s["motif"] == "image_cassee")
    assert admin.post(f"/api/admin/signalements/{sid}/resoudre").status_code == 200


def test_historique_et_activite(eleve, epreuve_gratuite):
    eleve.get(f"/api/epreuves/{epreuve_gratuite}")
    hist = eleve.get("/api/me/historique").json()
    assert any(h["epreuve_id"] == epreuve_gratuite for h in hist)
    act = eleve.get("/api/me/activite")
    assert act.status_code == 200
    types = {i["type"] for i in act.json()}
    assert "consultation" in types
