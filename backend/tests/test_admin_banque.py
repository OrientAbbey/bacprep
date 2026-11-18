"""Tests API admin de la banque du générateur V4.10."""
from __future__ import annotations

import json
import uuid

from app.db_models import BanqueClasseMetaORM, BanqueJournalORM, ReferentielOptionORM


def _option_id(admin, scope: str, code: str) -> str:
    grouped = admin.get("/api/admin/referentiel-options").json()
    return next(row["id"] for row in grouped[scope] if row["code"] == code)


def _cree_matiere(admin, code: str) -> None:
    r = admin.post("/api/admin/referentiel-options", json={"scope": "matiere", "code": code})
    assert r.status_code == 200, r.text


def test_admin_banque_crud_et_garde_fous(admin, db):
    # Le référentiel est conservé entre tests ; repartir d'un état connu même
    # si une exécution précédente a été interrompue avant son nettoyage.
    db.query(ReferentielOptionORM).filter_by(scope="evaluation", code="SEQUENCE 4").delete()
    db.commit()
    meta_initiale = db.get(BanqueClasseMetaORM, "terminale")
    meta_initiale_valeurs = (
        (meta_initiale.a_examen, meta_initiale.specialite_obligatoire)
        if meta_initiale is not None
        else None
    )
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
    added_sequence = admin.post(
        "/api/admin/referentiel-options",
        json={"scope": "evaluation", "code": "SEQUENCE 4"},
    )
    assert added_sequence.status_code == 200, added_sequence.text
    assert admin.get("/api/admin/banque").json()["referentiel"]["sequences"] == [1, 2, 3, 4]
    fourth_sequence = admin.post("/api/admin/banque/exercices", json={**body, "session": 4})
    assert fourth_sequence.status_code == 200, fourth_sequence.text
    invalid_session = admin.post("/api/admin/banque/exercices", json={**body, "session": 5})
    assert invalid_session.status_code == 422
    assert admin.put(f"/api/admin/banque/exercices/{exercise['id']}", json={**body, "sujet": "Nouvelle question"}).status_code == 200
    assert admin.delete(f"/api/admin/banque/parties/{partie_id}").status_code == 409
    assert admin.delete(f"/api/admin/banque/exercices/{exercise['id']}").status_code == 200
    assert admin.delete(f"/api/admin/banque/exercices/{fourth_sequence.json()['id']}").status_code == 200
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
    # Les référentiels sont préservés entre les tests ; supprimer l'option
    # ajoutée ici pour éviter de polluer les tests suivants.
    db.query(ReferentielOptionORM).filter_by(scope="evaluation", code="SEQUENCE 4").delete()
    meta_finale = db.get(BanqueClasseMetaORM, "terminale")
    if meta_initiale_valeurs is None:
        if meta_finale is not None:
            db.delete(meta_finale)
    elif meta_finale is not None:
        meta_finale.a_examen, meta_finale.specialite_obligatoire = meta_initiale_valeurs
    db.commit()


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


def test_export_import_roundtrip(admin, monkeypatch):
    from app.routers import admin_banque

    archives: list[tuple[str, bytes]] = []

    class StockageArchive:
        def put_bytes(self, cle: str, donnees: bytes) -> None:
            archives.append((cle, donnees))

    monkeypatch.setattr(admin_banque, "get_storage", lambda: StockageArchive())

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
    importe = admin.post("/api/admin/banque/import", json={"mode": "fusionner", "snapshot": value})
    assert importe.status_code == 200, importe.text
    # Le JSON brut est archivé tel quel dans le stockage persistant : même si
    # l'import n'est pas encore un job relançable, on peut reconstruire la
    # banque ou vérifier ce qui a été envoyé.
    assert importe.json()["snapshot_cle"].startswith("banque-snapshots/")
    assert len(archives) == 1
    assert json.loads(archives[0][1].decode("utf-8")) == value
    listing = admin.get("/api/admin/banque").json()
    assert any(row["id"] == exercice.json()["id"] for row in listing["exercices"])
    bad = dict(value)
    bad["exercices"] = [{**value["exercices"][0], "partieId": "00000000-0000-0000-0000-000000000001"}]
    assert admin.post("/api/admin/banque/import", json={"mode": "fusionner", "snapshot": bad}).status_code == 422


def test_schema_banque_cible_structuration_export(admin, db):
    """Le schéma versionné décrit bien la structure de l'export ; l'export
    réels et le schéma partagent les mêmes clés de premier niveau."""
    import pathlib

    racine = pathlib.Path(__file__).resolve().parents[2]
    schema = __import__("json").loads((racine / "backend" / "schemas" / "banque-1.0.schema.json").read_text(encoding="utf-8"))
    assert schema["properties"]["schemaVersion"]["enum"] == ["1.0"]
    assert set(schema["required"]) == {"schemaVersion", "matieres", "parties", "classes", "specialites", "exercices"}

    export = admin.get("/api/admin/banque/export").json()
    assert set(export) == set(schema["required"]) | {"exportedAt"}
    assert export["schemaVersion"] == "1.0"


def test_journal_admin_filtrable(admin, db):
    row = BanqueJournalORM(user_id="u-test", generation_id="g-test", type="GENERATION", params_json="{}", details_json="{}")
    db.add(row)
    db.commit()
    result = admin.get("/api/admin/banque/journal", params={"user_id": "u-test", "type": "GENERATION"})
    assert result.status_code == 200
    assert any(entry["generation_id"] == "g-test" for entry in result.json())
