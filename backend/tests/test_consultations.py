"""Historique de consultation : une même épreuve ouverte deux fois en
parallèle ne doit pas produire de 500.

La page du lecteur et le préchargement hors-ligne demandent l'épreuve en même
temps ; les deux requêtes lisaient « aucune ligne » puis inséraient, et la
seconde violait la contrainte UNIQUE (user_id, epreuve_id).
"""
from __future__ import annotations

from datetime import timedelta

from app.core import store
from app.db import SessionLocal, utc_now
from app.db_models import ConsultationORM


def test_record_consultation_rattrape_la_course(eleve, db, epreuve_gratuite, monkeypatch):
    user_id = eleve.get("/api/auth/me").json()["id"]
    ancien = utc_now() - timedelta(days=3)

    # La ligne existe déjà (créée par la requête « gagnante »)...
    autre = SessionLocal()
    try:
        autre.add(ConsultationORM(user_id=user_id, epreuve_id=epreuve_gratuite, consulted_at=ancien))
        autre.commit()
    finally:
        autre.close()

    # ... mais la requête perdante a lu la base AVANT cette création : on
    # simule ce SELECT périmé (None) au premier appel seulement.
    appels = {"n": 0}
    vraie = store._consultation_row

    def perimee(session, uid, eid):
        appels["n"] += 1
        return None if appels["n"] == 1 else vraie(session, uid, eid)

    monkeypatch.setattr(store, "_consultation_row", perimee)
    store.record_consultation(db, user_id, epreuve_gratuite)

    assert appels["n"] == 2, "l'insertion en conflit n'a pas été rattrapée"
    db.expire_all()
    ligne = (
        db.query(ConsultationORM)
        .filter(ConsultationORM.user_id == user_id, ConsultationORM.epreuve_id == epreuve_gratuite)
        .one()
    )
    assert ligne.consulted_at > ancien, "l'horodatage n'a pas été rafraîchi"
    assert (
        db.query(ConsultationORM)
        .filter(ConsultationORM.user_id == user_id, ConsultationORM.epreuve_id == epreuve_gratuite)
        .count()
        == 1
    ), "la consultation a été dupliquée"
