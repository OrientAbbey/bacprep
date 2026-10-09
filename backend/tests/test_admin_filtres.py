"""Filtres et pagination des listes d'administration (notifications, signalements, journal)."""
from __future__ import annotations

from app.db import SessionLocal
from app.db_models import SignalementORM, UserORM


def _creer_notifs(admin, prefixe: str, n: int) -> list[str]:
    ids = []
    for i in range(n):
        r = admin.post("/api/admin/notifications", json={"titre": f"{prefixe}-{i:02d}", "message": "x", "type": "information"})
        assert r.status_code == 200, r.text
        ids.append(r.json()["id"])
    return ids


def _supprimer(admin, ids):
    for i in ids:
        admin.delete(f"/api/admin/notifications/{i}")


def test_notifications_paginees_filtrees_par_etat_et_recherche(admin):
    ids = _creer_notifs(admin, "ZZPAGE", 35)
    try:
        page1 = admin.get("/api/admin/notifications", params={"q": "zzpage", "limit": 30}).json()
        page2 = admin.get("/api/admin/notifications", params={"q": "zzpage", "limit": 30, "offset": 30}).json()
        assert len(page1) == 30 and len(page2) == 5
        assert not {n["id"] for n in page1} & {n["id"] for n in page2}  # pages disjointes
        assert len(admin.get("/api/admin/notifications", params={"limit": 1000}).json()) <= 100  # plafond serveur
        assert admin.post(f"/api/admin/notifications/{ids[0]}/toggle").status_code == 200
        inactives = admin.get("/api/admin/notifications", params={"q": "zzpage", "etat": "inactive"}).json()
        actives = admin.get("/api/admin/notifications", params={"q": "zzpage", "etat": "active", "limit": 100}).json()
        assert [n["id"] for n in inactives] == [ids[0]] and len(actives) == 34
    finally:
        _supprimer(admin, ids)


def test_recherche_notifications_sans_accent(admin):
    ids = _creer_notifs(admin, "Épreuve ajoutée ZZACC", 1)
    try:
        assert admin.get("/api/admin/notifications", params={"q": "epreuve ajoutee zzacc"}).json()
        assert not admin.get("/api/admin/notifications", params={"q": "introuvable-zzacc"}).json()
    finally:
        _supprimer(admin, ids)


def test_signalements_recherche_statut_et_pagination(admin, epreuve_gratuite):
    with SessionLocal() as db:
        uid = db.query(UserORM.id).first()[0]
        creees = []
        for i in range(5):
            s = SignalementORM(user_id=uid, epreuve_id=epreuve_gratuite, motif="autre", message=f"coquille ZZSIG {i}", statut="resolu" if i == 0 else "ouvert")
            db.add(s)
            creees.append(s)
        db.commit()
        ids = [s.id for s in creees]
    try:
        assert len(admin.get("/api/admin/signalements", params={"q": "zzsig"}).json()) == 5
        assert len(admin.get("/api/admin/signalements", params={"q": "zzsig", "statut": "ouvert"}).json()) == 4
        assert len(admin.get("/api/admin/signalements", params={"q": "zzsig", "statut": "resolu"}).json()) == 1
        p1 = admin.get("/api/admin/signalements", params={"q": "zzsig", "limit": 3}).json()
        p2 = admin.get("/api/admin/signalements", params={"q": "zzsig", "limit": 3, "offset": 3}).json()
        assert len(p1) == 3 and len(p2) == 2 and not {s["id"] for s in p1} & {s["id"] for s in p2}
    finally:
        with SessionLocal() as db:
            db.query(SignalementORM).filter(SignalementORM.id.in_(ids)).delete(synchronize_session=False)
            db.commit()


def test_journal_filtre_par_action_ou_email(admin):
    p = admin.post("/api/admin/plans", json={"scope": "annee", "libelle": "Journal", "prix": 300, "duree_jours": 30}).json()["id"]
    try:
        tous = admin.get("/api/admin/events", params={"limit": 300}).json()
        filtres = admin.get("/api/admin/events", params={"q": "plan_cree"}).json()
        assert filtres and all("plan_cree" in e["action"] for e in filtres) and len(filtres) <= len(tous)
        assert not admin.get("/api/admin/events", params={"q": "action-qui-nexiste-pas"}).json()
        un = admin.get("/api/admin/events", params={"q": "plan_cree", "limit": 1}).json()
        assert len(un) == 1
    finally:
        admin.delete(f"/api/admin/plans/{p}")
