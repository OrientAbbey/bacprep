"""Tests d'intégration des routes élève et de leur silence V4.10."""
from __future__ import annotations

import json
import uuid
from datetime import timedelta

from app.db import utc_now
from app.db_models import (
    BanqueExerciceORM,
    BanqueGenerationORM,
    BanqueJournalORM,
    BanquePartieORM,
    ReferentielOptionORM,
    SubscriptionORM,
    UserORM,
)


def _ensure_option(db, scope: str, code: str) -> None:
    if db.query(ReferentielOptionORM).filter_by(scope=scope, code=code).first() is None:
        db.add(ReferentielOptionORM(scope=scope, code=code, position=1000))
        db.flush()


def _setup_banque(db, user):
    subject = f"API Banque Math {uuid.uuid4().hex}"
    _ensure_option(db, "matiere", subject)
    _ensure_option(db, "classe", "terminale")
    now = utc_now()
    db.add(SubscriptionORM(
        user_id=user.id, evaluation="ALL", classe="terminale", filiere="A",
        matiere=subject, annee="ALL", start_date=now, end_date=now + timedelta(days=30), statut="active",
    ))
    part_ids = []
    for i in range(8):
        part = BanquePartieORM(matiere=subject, nom=f"Partie {i}", ordre=i)
        db.add(part)
        db.flush()
        part_ids.append(part.id)
        db.add(BanqueExerciceORM(
            sujet=f"Sujet {i}", corrige=f"Corrigé {i}", partie_id=part.id,
            session=1, niveau_intrinseque="Moyen", tag_examen=True, actif=True,
            matieres_json=json.dumps([subject]), classes_json='["terminale"]', series_json='["SPECIAL:Aucune"]',
        ))
    _ensure_option(db, "evaluation", "unused")
    db.commit()
    return subject


def test_options_eleve_refletent_la_banque_active_sans_contenu(eleve, db):
    user = db.query(UserORM).filter_by(email="eleve@test.cm").one()
    subject = _setup_banque(db, user)

    response = eleve.get("/api/banque/options")

    assert response.status_code == 200, response.text
    options = response.json()
    assert subject in options["matieres"]
    assert "terminale" in options["classes"]
    assert options["series"] == []
    assert options["sequences"] == [1, 2, 3]
    assert set(options) == {"matieres", "classes", "series", "sequences"}
    assert "sujet" not in response.text and "corrige" not in response.text


def test_generation_complete_et_corrige_aligne(eleve, db):
    user = db.query(UserORM).filter_by(email="eleve@test.cm").one()
    subject = _setup_banque(db, user)
    response = eleve.post("/api/banque/generer", json={
        "matiere": subject, "classe": "terminale", "sequence": 1, "mode": "sequence", "difficulte": "Moyen",
    })
    assert response.status_code == 200, response.text
    data = response.json()
    assert len(data["exercices"]) == 4
    assert set(data) == {"generation_id", "exercices", "parametres"}
    correction = eleve.get(f"/api/banque/generations/{data['generation_id']}/corrige")
    assert correction.status_code == 200
    assert [x["numero"] for x in correction.json()["exercices"]] == [1, 2, 3, 4]
    assert all(x["contenu"].startswith("Corrigé") for x in correction.json()["exercices"])
    rendered = eleve.get(f"/api/banque/generations/{data['generation_id']}").json()
    assert [x["numero"] for x in rendered["exercices"]] == [1, 2, 3, 4]


def test_generation_incomplete_is_silent_and_journalisee(eleve, db):
    user = db.query(UserORM).filter_by(email="eleve@test.cm").one()
    subject = _setup_banque(db, user)
    # Pour un pool d'un exercice, la phase de composition ne peut produire qu'un résultat partiel.
    db.query(BanqueExerciceORM).filter(BanqueExerciceORM.matieres_json.contains(subject)).delete(synchronize_session=False)
    part = BanquePartieORM(matiere=subject, nom="Unique", ordre=0)
    db.add(part)
    db.flush()
    db.add(BanqueExerciceORM(
        sujet="Unique sujet", corrige="Unique corrigé", partie_id=part.id, session=1,
        niveau_intrinseque="Moyen", tag_examen=True, actif=True,
        matieres_json=json.dumps([subject]), classes_json='["terminale"]', series_json='["SPECIAL:Aucune"]',
    ))
    db.commit()
    response = eleve.post("/api/banque/generer", json={
        "matiere": subject, "classe": "terminale", "sequence": 1, "mode": "sequence", "difficulte": "Moyen",
    })
    assert response.status_code == 200, response.text
    data = response.json()
    assert len(data["exercices"]) < 4
    assert "message" not in data and "warning" not in data and "incomplete" not in data
    journal = db.query(BanqueJournalORM).filter_by(generation_id=data["generation_id"]).all()
    assert any(row.type == "INCOMPLETE_EXAM" for row in journal)
    assert any(row.type == "GENERATION" for row in journal)


def test_gating_refuse_matiere_non_abonnee(eleve, db):
    user = db.query(UserORM).filter_by(email="eleve@test.cm").one()
    subject = "No Subscription Subject"
    _ensure_option(db, "matiere", subject)
    db.commit()
    response = eleve.post("/api/banque/generer", json={
        "matiere": subject, "classe": "terminale", "sequence": 1, "mode": "sequence", "difficulte": "Facile",
    })
    assert response.status_code == 403


def test_specialite_omise_limitee_aux_series_abonnees(eleve, db):
    user = db.query(UserORM).filter_by(email="eleve@test.cm").one()
    subject = _setup_banque(db, user)
    _ensure_option(db, "serie", "C")
    part = BanquePartieORM(matiere=subject, nom="Partie série C", ordre=20)
    db.add(part)
    db.flush()
    db.add(BanqueExerciceORM(
        sujet="Contenu réservé à C", corrige="Corrigé réservé à C", partie_id=part.id,
        session=1, niveau_intrinseque="Facile", tag_examen=True, actif=True,
        matieres_json=json.dumps([subject]), classes_json='["terminale"]', series_json='["C"]',
    ))
    db.commit()

    response = eleve.post("/api/banque/generer", json={
        "matiere": subject, "classe": "terminale", "sequence": 1, "mode": "sequence", "difficulte": "Facile",
    })
    assert response.status_code == 200, response.text
    generation = eleve.get(f"/api/banque/generations/{response.json()['generation_id']}").json()
    assert all("réservé à C" not in exercise["contenu"] for exercise in generation["exercices"])

    denied = eleve.post("/api/banque/generer", json={
        "matiere": subject, "classe": "terminale", "serie": "C", "sequence": 1,
        "mode": "sequence", "difficulte": "Facile",
    })
    assert denied.status_code == 403


def test_generation_et_corrige_reserves_au_proprietaire(eleve, visiteur, db):
    user = db.query(UserORM).filter_by(email="eleve@test.cm").one()
    subject = _setup_banque(db, user)
    created = eleve.post("/api/banque/generer", json={
        "matiere": subject, "classe": "terminale", "sequence": 1, "mode": "sequence", "difficulte": "Facile",
    })
    assert created.status_code == 200, created.text
    generation_id = created.json()["generation_id"]
    assert visiteur.get(f"/api/banque/generations/{generation_id}").status_code in (401, 403)
    assert visiteur.get(f"/api/banque/generations/{generation_id}/corrige").status_code in (401, 403)
    autre = visiteur.post("/api/auth/mock-login", json={"email": "autre-banque@test.cm", "nom": "Autre"})
    assert autre.status_code == 200
    assert visiteur.get(f"/api/banque/generations/{generation_id}").status_code == 404
    assert visiteur.get(f"/api/banque/generations/{generation_id}/corrige").status_code == 404
    assert eleve.get(f"/api/banque/generations/{generation_id}/corrige").status_code == 200


def test_historique_expire_preserve_generation_la_plus_recente(eleve, db):
    user_id = uuid.uuid4().hex
    now = utc_now()
    stale_ids = []
    for day in (400, 500):
        row = BanqueGenerationORM(
            user_id=user_id,
            params_json="{}",
            exercices_json="[]",
            created_at=now - timedelta(days=day),
        )
        db.add(row)
        db.flush()
        stale_ids.append(row.id)
    latest = BanqueGenerationORM(
        user_id=user_id,
        params_json="{}",
        exercices_json="[]",
        created_at=now - timedelta(days=380),
    )
    db.add(latest)
    db.flush()
    latest_id = latest.id
    db.commit()

    # La génération la plus récente est définie par created_at, même si elle
    # a elle-même plus de 12 mois ; elle doit survivre à chaque purge.
    from app.routers.banque import _purger_historique
    _purger_historique(db, now)
    db.commit()

    remaining = {row.id for row in db.query(BanqueGenerationORM).filter_by(user_id=user_id).all()}
    assert latest_id in remaining
    assert set(stale_ids).isdisjoint(remaining)
    assert db.query(BanqueJournalORM).filter_by(type="INFO_HISTORY_PURGED", user_id=user_id).count() == 1


def test_suppression_compte_preserve_journal_technique(eleve, db):
    user = db.query(UserORM).filter_by(email="eleve@test.cm").one()
    journal = BanqueJournalORM(
        user_id=user.id, generation_id="generation-effacee", type="GENERATION",
        params_json="{}", details_json="{}",
    )
    db.add(journal)
    db.commit()
    user_id = user.id
    journal_id = journal.id

    response = eleve.delete("/api/me/compte")
    assert response.status_code == 200, response.text
    db.expire_all()
    assert db.get(UserORM, user_id) is None
    assert db.query(BanqueJournalORM).filter_by(id=journal_id).count() == 1
