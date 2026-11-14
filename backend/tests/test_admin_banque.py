"""Tests API admin de la banque du générateur V4.10."""
from __future__ import annotations

import uuid

from app.db_models import BanqueJournalORM


def _option_id(admin, scope: str, code: str) -> str:
    grouped = admin.get("/api/admin/referentiel-options").json()
    return next(row["id"] for row in grouped[scope] if row["code"] == code)


def _cree_matiere(admin, code: str) -> None:
    r = admin.post("/api/admin/referentiel-options", json={"scope": "matiere", "code": code})
    assert r.status_code == 200, r.text


def test_admin_banque_crud_et_garde_fous(admin, db):
    matiere = "Banque Test"
    _cree_matiere(admin, matiere)
    part = admin.post("/api/admin/banque/parties", json={"matiere": matiere, "nom": "Partie A"})
    assert part.status_code == 200, part.text
    partie_id = part.json()["id"]
    body = {
        "sujet": "Question test",
        "corrige": "Réponse test",
        "partie_id": partie_id,
        "session": 1,
        "niveau_intrinseque": "Moyen",
        "tag_examen": False,
        "actif": True,
        "matieres": [matiere],
        "classes": ["terminale"],
        "series": ["SPECIAL:Aucune"],
    }
    created = admin.post("/api/admin/banque/exercices", json=body)
    assert created.status_code == 200, created.text
    exercise = created.json()
    assert exercise["matieres"] == [matiere]
    assert exercise["classes"] == ["terminale"]
    assert admin.get("/api/admin/banque").json()["referentiel"]["sequences"] == [1, 2, 3]
    invalid_session = admin.post("/api/admin/banque/exercices", json={**body, "session": 4})
    assert invalid_session.status_code == 422
    assert admin.put(f"/api/admin/banque/exercices/{exercise['id']}", json={**body, "sujet": "Nouvelle question"}).status_code == 200
    assert admin.delete(f"/api/admin/banque/parties/{partie_id}").status_code == 409
    assert admin.delete(f"/api/admin/banque/exercices/{exercise['id']}").status_code == 200
    assert admin.delete(f"/api/admin/banque/parties/{partie_id}").status_code == 409  # dernière partie
    second = admin.post("/api/admin/banque/parties", json={"matiere": matiere, "nom": "Partie B"})
    assert second.status_code == 200
    assert admin.delete(f"/api/admin/banque/parties/{partie_id}").status_code == 200
    assert admin.put("/api/admin/banque/classes/terminale", json={"a_examen": True, "specialite_obligatoire": True}).status_code == 200
    events = admin.get("/api/admin/events").json()
    actions = [event["action"] for event in events]
    assert "banque_partie_creee" in actions
    assert "banque_exercice_cree" in actions
    assert "banque_classe_meta_modifiee" in actions


def test_admin_banque_rejette_referentiel_inconnu_et_tag_session_vide(admin):
    r = admin.post("/api/admin/banque/parties", json={"matiere": "Inconnue-xyz", "nom": "A"})
    assert r.status_code == 422
    matiere = "Banque Tag Test"
    _cree_matiere(admin, matiere)
    part = admin.post("/api/admin/banque/parties", json={"matiere": matiere, "nom": "A"}).json()
    r = admin.post("/api/admin/banque/exercices", json={
        "sujet": "x", "corrige": "y", "partie_id": part["id"], "session": None,
        "tag_examen": True, "matieres": [matiere], "classes": ["terminale"], "series": [],
    })
    assert r.status_code == 422


def test_export_import_roundtrip(admin):
    matiere = "Banque Roundtrip"
    _cree_matiere(admin, matiere)
    partie = admin.post("/api/admin/banque/parties", json={"matiere": matiere, "nom": "A"}).json()
    exercice = admin.post("/api/admin/banque/exercices", json={
        "id": str(uuid.uuid4()), "sujet": "# Sujet", "corrige": "# Corrigé",
        "partie_id": partie["id"], "session": 1, "tag_examen": True,
        "matieres": [matiere], "classes": ["terminale"], "series": ["SPECIAL:Aucune"],
    })
    assert exercice.status_code == 200, exercice.text
    snapshot = admin.get("/api/admin/banque/export")
    assert snapshot.status_code == 200
    value = snapshot.json()
    assert value["schemaVersion"] == "1.0"
    assert admin.post("/api/admin/banque/import", json={"mode": "fusionner", "snapshot": value}).status_code == 200
    listing = admin.get("/api/admin/banque").json()
    assert any(row["id"] == exercice.json()["id"] for row in listing["exercices"])
    bad = dict(value)
    bad["exercices"] = [{**value["exercices"][0], "partieId": "00000000-0000-0000-0000-000000000001"}]
    assert admin.post("/api/admin/banque/import", json={"mode": "fusionner", "snapshot": bad}).status_code == 422


def test_journal_admin_filtrable(admin, db):
    row = BanqueJournalORM(user_id="u-test", generation_id="g-test", type="GENERATION", params_json="{}", details_json="{}")
    db.add(row)
    db.commit()
    result = admin.get("/api/admin/banque/journal", params={"user_id": "u-test", "type": "GENERATION"})
    assert result.status_code == 200
    assert any(entry["generation_id"] == "g-test" for entry in result.json())
