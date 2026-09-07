"""Smoke tests batch de la vague d'améliorations 2026-09 (TestClient
FastAPI, base SQLite temporaire — aucun serveur lancé). Couvre : filtre
Ouvert/Payant serveur, notes (CRUD + enrichissement), signalements
(anti-doublon), profil étendu, activité, admin (counts par statut, stats
enrichies, journal d'audit, résolution de signalement).

Usage : cd backend && python scripts_dev/smoke_v4.py
"""

from __future__ import annotations

import os
import tempfile

# Base SQLite jetable : mkstemp (création sécurisée, pas de course) plutôt
# que mktemp (nom prédictible).
_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.close(_fd)
os.environ["DATABASE_URL"] = "sqlite:///" + _db_path.replace("\\", "/")

from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.db_models import EpreuveORM  # noqa: E402
from app.main import app  # noqa: E402


def main() -> None:
    with TestClient(app) as c:
        # --- Setup : élève connecté, une épreuve rendue payante
        assert c.post("/api/auth/mock-login", json={"email": "el@x.cm", "nom": "Elève Test"}).status_code == 200
        eps = c.get("/api/epreuves").json()
        cible = eps[0]
        db = SessionLocal()
        db.query(EpreuveORM).filter(EpreuveORM.id == cible["id"]).update({"gratuit": False})
        db.commit()
        db.close()

        # --- Filtre Ouvert/Payant côté serveur (Lot B2)
        assert c.get("/api/epreuves", params={"acces_type": "ouvert"}).json() == []
        payants = c.get("/api/epreuves", params={"acces_type": "payant"}).json()
        assert [e["id"] for e in payants] == [cible["id"]]
        r = c.post(
            "/api/subscriptions/checkout",
            json={"scope": "epreuve", "epreuve_id": cible["id"], "provider": "orange"},
        )
        c.post("/api/payments/simulate-webhook", json={"reference_agregateur": r.json()["reference_agregateur"]})
        assert [e["id"] for e in c.get("/api/epreuves", params={"acces_type": "ouvert"}).json()] == [cible["id"]]
        assert c.get("/api/epreuves", params={"acces_type": "payant"}).json() == []
        print("OK filtre ouvert/payant serveur")

        # --- Notes (Lot D)
        r = c.post(
            f"/api/epreuves/{cible['id']}/notes",
            json={"cible": "sujet", "contexte_extrait": "Passage sélectionné…", "contenu": "Ma **note**."},
        )
        assert r.status_code == 200, r.text
        note_id = r.json()["id"]
        notes = c.get("/api/me/notes").json()
        assert len(notes) == 1 and notes[0]["matiere"] == cible["matiere"]
        r = c.put(f"/api/me/notes/{note_id}", json={"contenu": "Note modifiée"})
        assert r.json()["contenu"] == "Note modifiée"
        assert c.delete(f"/api/me/notes/{note_id}").json()["ok"]
        assert c.get("/api/me/notes").json() == []
        print("OK notes CRUD")

        # --- Profil étendu (Lot E1)
        r = c.put("/api/me/profil", json={"niveau": "SECONDAIRE", "classe": "Terminale", "etablissement": "Lycée X"})
        assert r.json()["ok"]
        profil = c.get("/api/me/profil").json()
        assert profil["classe"] == "terminale" and profil["etablissement"] == "Lycée X"
        print("OK profil étendu")

        # --- Signalements (Lot E3)
        r = c.post(f"/api/epreuves/{cible['id']}/signalements", json={"motif": "erreur_enonce", "message": "Q2 fausse"})
        assert r.status_code == 200, r.text
        assert (
            c.post(f"/api/epreuves/{cible['id']}/signalements", json={"motif": "erreur_enonce"}).status_code == 409
        ), "anti-doublon attendu"
        assert c.post(f"/api/epreuves/{cible['id']}/signalements", json={"motif": "motif_bidon"}).status_code == 400
        print("OK signalements + anti-doublon")

        # --- Activité (Lot E2) — ouvrir l'épreuve génère une consultation
        assert c.get(f"/api/epreuves/{cible['id']}").status_code == 200
        act = c.get("/api/me/activite").json()
        types = {i["type"] for i in act}
        assert {"connexion", "consultation", "abonnement", "paiement"} <= types, types
        print("OK activité", sorted(types))

        # --- Admin (ADMIN_EMAILS vide dans l'environnement de test : tout
        # email avec le bon jeton est autorisé, cf. admin_login)
        r = c.post("/api/admin/login", json={"email": "admin@x.cm", "token": os.getenv("ADMIN_TOKEN", "admin123")})
        assert r.status_code == 200, r.text
        h = {"X-Admin-Session": r.json()["session_token"]}

        counts = c.get("/api/admin/epreuves/counts", headers=h).json()
        assert counts["tous"] == counts["brouillon"] + counts["a_reviser"] + counts["publie"], counts

        lst = c.get("/api/admin/epreuves", params={"statut": "publie"}, headers=h).json()
        assert all(e["statut"] == "publie" for e in lst)

        stats = c.get("/api/admin/stats", headers=h).json()
        assert "stockage" in stats and "revenus_par_mois" in stats and "signalements_ouverts" in stats
        assert stats["signalements_ouverts"] == 1

        events = c.get("/api/admin/events", headers=h).json()
        assert any(e["action"] == "admin_login" for e in events)
        assert all(e.get("email") for e in events if e["action"].startswith(("created", "admin_login")))

        sigs = c.get("/api/admin/signalements", headers=h).json()
        assert len(sigs) == 1 and sigs[0]["auteur_email"] == "el@x.cm"
        assert c.post(f"/api/admin/signalements/{sigs[0]['id']}/resoudre", headers=h).json()["ok"]
        assert c.get("/api/admin/signalements", params={"statut": "ouvert"}, headers=h).json() == []
        print("OK admin (counts, stats, journal, signalements)")

    print("SMOKE V4 : TOUS OK")


if __name__ == "__main__":
    main()
