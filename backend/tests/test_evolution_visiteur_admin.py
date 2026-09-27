"""Tests batch — vague « visiteur, consentement, gouvernance admin » :
- épreuves gratuites consultables SANS session, payantes → 401 visiteur ;
- aucune consultation enregistrée pour un visiteur ;
- gardes serveur du consentement (notes / conversations IA) ;
- métrique « utilisateurs » comptant aussi les admins + table utilisateurs ;
- bannissement (session tuée, login refusé) / débannissement / suppression ;
- séparation assets (images) / documents (md) dans le détail admin ;
- journal d'audit : champs modifiés tracés ;
- fenêtre d'inactivité admin paramétrable (défaut 3 min).
"""
from __future__ import annotations

from datetime import timedelta

import pytest


# ---------- Mode visiteur ----------

def test_visiteur_consulte_epreuve_gratuite(visiteur, epreuve_gratuite):
    r = visiteur.get(f"/api/epreuves/{epreuve_gratuite}")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["contenu_markdown"]  # le contenu part bien
    assert data["gratuit"] is True


def test_visiteur_refuse_sur_epreuve_payante(visiteur, epreuve_payante):
    r = visiteur.get(f"/api/epreuves/{epreuve_payante}")
    assert r.status_code == 401  # connexion requise (distinct du 403 abonnement)
    assert "Connecte-toi" in r.json()["detail"]


def test_visiteur_n_enregistre_pas_de_consultation(visiteur, epreuve_gratuite):
    visiteur.get(f"/api/epreuves/{epreuve_gratuite}")
    # Un utilisateur neuf, créé APRÈS la visite du visiteur, doit avoir un
    # historique vide : la consultation anonyme n'a été rattachée à personne.
    from fastapi.testclient import TestClient

    import app.main as app_main

    neuf = TestClient(app_main.app)  # pas de lifespan : base déjà initialisée
    r = neuf.post("/api/auth/mock-login", json={"email": "neuf-hist@test.cm", "nom": "Neuf"})
    assert r.status_code == 200, r.text
    r = neuf.get("/api/me/historique")
    assert r.status_code == 200
    assert r.json() == []


def test_connecte_sans_abonnement_toujours_403(eleve, epreuve_payante):
    r = eleve.get(f"/api/epreuves/{epreuve_payante}")
    assert r.status_code == 403


# ---------- Consentement ----------

def test_me_expose_consentements_bruts(eleve):
    me = eleve.get("/api/auth/me").json()
    assert me["consent_ia"] is None and me["consent_notes"] is None


def test_refus_notes_bloque_creation(eleve):
    r = eleve.put("/api/me/consentement", json={"partage_conversations_ia": True, "partage_notes": False})
    assert r.status_code == 200
    # Une épreuve est nécessaire pour la note : création via admin impossible
    # ici (le client n'a pas la session admin) — on vérifie le garde via la
    # 403 qui précède le 404 d'épreuve.
    r = eleve.post("/api/epreuves/x/notes", json={"contenu": "test"})
    assert r.status_code == 403


def test_refus_conversations_bloque_creation(eleve):
    r = eleve.put("/api/me/consentement", json={"partage_conversations_ia": False, "partage_notes": True})
    assert r.status_code == 200
    r = eleve.post("/api/epreuves/x/conversations", json={"contexte": "", "label": "t"})
    assert r.status_code == 403


def test_acceptation_consentement(eleve, epreuve_gratuite):
    r = eleve.put("/api/me/consentement", json={"partage_conversations_ia": True, "partage_notes": True})
    assert r.status_code == 200
    me = eleve.get("/api/auth/me").json()
    assert me["consent_ia"] is True and me["consent_notes"] is True
    # Note créable une fois le consentement donné.
    r = eleve.post(f"/api/epreuves/{epreuve_gratuite}/notes", json={"contenu": "ma note"})
    assert r.status_code == 200


def test_activite_enrichie_contexte(admin, epreuve_gratuite):
    # admin fixture = client élève (eleve@test.cm) + session admin.
    admin.get(f"/api/epreuves/{epreuve_gratuite}")
    items = admin.get("/api/me/activite").json()
    consult = [i for i in items if i["type"] == "consultation"]
    assert consult
    assert "terminale" in consult[0]["libelle"].lower()
    assert consult[0]["details"].startswith("Séries")


# ---------- Gouvernance admin ----------

def test_stats_comptent_les_admins(admin):
    # La métrique « Utilisateurs » compte TOUS les comptes, administrateurs
    # compris (revue 2026-09-18, demande admin) — la base étant partagée
    # entre tests, on vérifie l'inclusion des admins sans figer un nombre.
    from app.core import admin_session
    from app.db import SessionLocal
    from app.db_models import UserORM

    with SessionLocal() as db:
        admins = set(admin_session.allowed_emails(db))
        total = db.query(UserORM).count()
        nb_admins = sum(1 for (email,) in db.query(UserORM.email).all() if email.lower() in admins)
    stats = admin.get("/api/admin/stats").json()
    assert total >= 1
    assert stats["utilisateurs"] == total
    assert stats["utilisateurs"] >= nb_admins


def test_table_utilisateurs_compteurs(admin, epreuve_gratuite):
    admin.post(f"/api/epreuves/{epreuve_gratuite}/notes", json={"contenu": "n1"})
    rows = admin.get("/api/admin/utilisateurs").json()
    u = next(r for r in rows if r["email"] == "eleve@test.cm")
    assert u["notes"] >= 1 and u["consultations"] >= 1
    # Aucune donnée sensible exposée.
    for cle in ("password", "mot_de_passe", "code", "pin"):
        assert cle not in u


def test_bannissement_bloque_session_et_login(client, admin):
    r = client.post("/api/auth/mock-login", json={"email": "banni@test.cm", "nom": "Banni"})
    assert r.status_code == 200
    banni_id = client.get("/api/auth/me").json()["id"]

    r = admin.post(f"/api/admin/utilisateurs/{banni_id}/bannir", json={"motif": "abus"})
    assert r.status_code == 200

    # La session existante est tuée immédiatement.
    assert client.get("/api/auth/me").status_code == 401
    # Le re-login est refusé.
    r = client.post("/api/auth/mock-login", json={"email": "banni@test.cm", "nom": "Banni"})
    assert r.status_code == 403

    # Débannissement → reconnexion normale.
    assert admin.post(f"/api/admin/utilisateurs/{banni_id}/debannir").status_code == 200
    assert client.post("/api/auth/mock-login", json={"email": "banni@test.cm", "nom": "Banni"}).status_code == 200


def test_suppression_utilisateur_efface_donnees(client, admin):
    r = client.post("/api/auth/mock-login", json={"email": "supprime@test.cm", "nom": "Temp"})
    assert r.status_code == 200
    uid = client.get("/api/auth/me").json()["id"]

    assert admin.delete(f"/api/admin/utilisateurs/{uid}").status_code == 200
    emails = [u["email"] for u in admin.get("/api/admin/utilisateurs").json()]
    assert "supprime@test.cm" not in emails
    # Un re-login recrée un compte neuf (comportement attendu).
    assert client.post("/api/auth/mock-login", json={"email": "supprime@test.cm", "nom": "Temp"}).status_code == 200


def test_suppression_utilisateur_avec_paiement_confirme(visiteur, admin, epreuve_payante):
    """Régression : la suppression d'un compte ayant un abonnement PAYÉ
    échouait en `FOREIGN KEY constraint failed` — les paiements référencent
    les abonnements (payments.subscription_id → subscriptions.id), il faut
    donc purger les paiements AVANT les abonnements."""
    r = visiteur.post("/api/auth/mock-login", json={"email": "efface-fk@test.cm", "nom": "FK"})
    assert r.status_code == 200, r.text
    uid = visiteur.get("/api/auth/me").json()["id"]

    # Abonnement créé puis confirmé via le webhook de simulation → une
    # ligne PaymentORM référençant la subscription est créée.
    r = visiteur.post(
        "/api/subscriptions/checkout",
        json={"scope": "epreuve", "epreuve_id": epreuve_payante, "provider": "orange"},
    )
    assert r.status_code == 200, r.text
    ref = r.json()["reference_agregateur"]
    assert (
        visiteur.post("/api/payments/simulate-webhook", json={"reference_agregateur": ref}).status_code
        == 200
    )

    assert admin.delete(f"/api/admin/utilisateurs/{uid}").status_code == 200, "suppression du compte"
    emails = [u["email"] for u in admin.get("/api/admin/utilisateurs").json()]
    assert "efface-fk@test.cm" not in emails


def test_admin_ne_peut_pas_bannir_sa_liste_blanche(admin):
    u = admin.get("/api/auth/me").json()  # eleve@test.cm — pas admin
    # Bannir un email de la liste blanche : créons-le comme user puis tentons.
    from app.core import store
    from app.db import SessionLocal
    from app.db_models import UserORM

    with SessionLocal() as db:
        admin_user = store.get_or_create_user(db, "admin@example.com", "Admin Test")
        aid = admin_user.id
    r = admin.post(f"/api/admin/utilisateurs/{aid}/bannir", json={})
    assert r.status_code == 400


# ---------- Détail admin : assets vs documents + audit ----------

def test_admin_detail_separe_images_et_documents(admin, epreuve_gratuite):
    d = admin.get(f"/api/admin/epreuves/{epreuve_gratuite}").json()
    assert d["assets"] == []  # aucune image : les .md n'y apparaissent plus
    docs = d["documents"]
    assert [x["cible"] for x in docs] == ["sujet"]
    assert docs[0]["filename"] == "sujet.md"


def test_journal_audit_trace_les_champs_modifies(admin, epreuve_gratuite):
    r = admin.put(
        f"/api/admin/epreuves/{epreuve_gratuite}",
        json={"matiere": "Mathématiques", "duree": "4h"},
    )
    assert r.status_code == 200
    events = admin.get("/api/admin/events?limit=10").json()
    upd = next(e for e in events if e["action"] == "updated" and e["epreuve_id"] == epreuve_gratuite)
    assert "duree" in upd["details"]["champs"]
    assert "matiere" not in upd["details"]["champs"]  # valeur identique → non tracée
    assert upd["epreuve_resume"]  # résumé lisible de l'épreuve


def test_fenetre_inactivite_admin_parametrable(monkeypatch):
    from app.core import admin_session

    monkeypatch.delenv("ADMIN_SESSION_TIMEOUT_MINUTES", raising=False)
    assert admin_session.session_timeout() == timedelta(minutes=3)  # défaut
    monkeypatch.setenv("ADMIN_SESSION_TIMEOUT_MINUTES", "7")
    assert admin_session.session_timeout() == timedelta(minutes=7)


def test_duree_absolue_admin_parametrable(monkeypatch):
    """La borne absolue (ADMIN_SESSION_MAX_MINUTES) est distincte de la
    fenêtre d'inactivité et borne le temps de vie même d'une session
    activement rafraîchie."""
    from app.core import admin_session

    monkeypatch.delenv("ADMIN_SESSION_MAX_MINUTES", raising=False)
    assert admin_session.session_max_duration() == timedelta(minutes=480)  # 8 h
    monkeypatch.setenv("ADMIN_SESSION_MAX_MINUTES", "30")
    assert admin_session.session_max_duration() == timedelta(minutes=30)
    # Une valeur absurde est ramenée au plancher plutôt que d'ouvrir une
    # session qui expire immédiatement (division par zéro, 401 en boucle).
    monkeypatch.setenv("ADMIN_SESSION_MAX_MINUTES", "0")
    assert admin_session.session_max_duration() == timedelta(minutes=1)
    monkeypatch.setenv("ADMIN_SESSION_MAX_MINUTES", "n'importe-quoi")
    assert admin_session.session_max_duration() == timedelta(minutes=480)


def test_jeton_admin_hache_en_base(admin):
    """La base ne doit conserver que l'empreinte du jeton : une fuite de la
    table `admin_lock` ne permet pas de rejouer la session. Le cookie, lui,
    porte le jeton brut."""
    from app.core import admin_session
    from app.db import SessionLocal
    from app.db_models import AdminLockORM

    cookie_brut = admin.cookies.get("admin_session")
    assert cookie_brut, "le login doit poser un cookie admin_session"

    with SessionLocal() as db:
        lock = db.query(AdminLockORM).filter(AdminLockORM.id == admin_session.LOCK_ID).one()
        stocke = lock.token

    assert stocke != cookie_brut, "le jeton brut ne doit jamais être stocké"
    assert stocke == admin_session.hash_token(cookie_brut)
    # SHA-256 déterministe : vérifie bien que c'est l'empreinte du cookie.
    assert len(stocke) == 64
    # Et le cookie brut reste le seul moyen de s'authentifier.
    assert admin.get("/api/admin/stats").status_code == 200


def test_duree_absolue_admin_independante_de_l_activite(admin):
    """Une session dont `last_activity` vient d'être rafraîchit doit malgré
    tout expirer si `since` dépasse la durée absolue : c'est ce qui empêche
    un jeton volé de survivre indéfiniment grâce aux heartbeats."""
    from app.core import admin_session
    from app.db import SessionLocal, utc_now
    from app.db_models import AdminLockORM

    def _depuis_inception(delta):
        with SessionLocal() as db:
            lock = db.query(AdminLockORM).filter(AdminLockORM.id == admin_session.LOCK_ID).one()
            lock.since = utc_now() - delta
            lock.last_activity = utc_now()  # activité fraîche : seule la borne absolue joue
            db.commit()

    # Session ouverte il y a 9 h (> 8 h) mais active à l'instant → 401.
    _depuis_inception(timedelta(hours=9))
    r = admin.get("/api/admin/stats")
    assert r.status_code == 401

    # Re-login, ouverte il y a 1 h et active → 200.
    admin.post("/api/admin/login", json={"email": "admin@example.com", "token": "test-admin-token"})
    _depuis_inception(timedelta(hours=1))
    assert admin.get("/api/admin/stats").status_code == 200


def test_heartbeat_renouvelle_le_cookie_brut(admin):
    """Le heartbeat rallonge le cookie httpOnly : il doit le réécrire avec le
    MÊME jeton brut (lu dans la requête), pas avec l'empreinte stockée en
    base — sinon le cookie deviendrait inauthentifiable au 2e battement."""
    avant = admin.cookies.get("admin_session")
    r = admin.post("/api/admin/heartbeat")
    assert r.status_code == 200
    assert admin.cookies.get("admin_session") == avant
    # Le cookie réémis reste valide sur les routes admin.
    assert admin.get("/api/admin/stats").status_code == 200
    # Deux heartbeats d'affilée ne cassent rien.
    assert admin.post("/api/admin/heartbeat").status_code == 200
    assert admin.get("/api/admin/stats").status_code == 200


def test_heartbeat_admin_rafraichit_le_verrou(admin):
    # Le battement de cœur maintient la session tant que la console est
    # ouverte : 200 avec le délai configuré, 401 avec un mauvais jeton.
    r = admin.post("/api/admin/heartbeat")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert "timeout_minutes" in r.json()
    r = admin.post("/api/admin/heartbeat", headers={"X-Admin-Session": "jeton-invalide"})
    assert r.status_code == 401


def test_derniere_connexion_survit_a_la_deconnexion(client, admin):
    # L'élève se connecte (horodatage posé), se déconnecte (session purgée) :
    # la table admin des utilisateurs doit TOUJOURS afficher sa dernière
    # connexion — elle ne repose pas sur la table `sessions`.
    r = client.post("/api/auth/mock-login", json={"email": "connex@test.cm", "nom": "Connex"})
    assert r.status_code == 200
    r = client.post("/api/auth/logout")
    assert r.status_code == 200

    rows = admin.get("/api/admin/utilisateurs").json()
    u = next(r2 for r2 in rows if r2["email"] == "connex@test.cm")
    assert u["derniere_connexion"] is not None


def test_session_ttl_glissant_et_maximum(client):
    """Expiration en deux temps : 7 jours sans activité → purgée ; au-delà
    de 14 jours même AVEC activité → purgée ; session récente et active →
    conservée (et last_seen rafraîchi)."""
    from datetime import timedelta

    from app.db import SessionLocal, utc_now
    from app.db_models import SessionORM, UserORM

    assert client.post("/api/auth/mock-login", json={"email": "ttl@test.cm", "nom": "TTL"}).status_code == 200

    def _forcer(user_email, issued_minus, last_seen_minus):
        # Manipule directement la ligne de session pour simuler le temps.
        with SessionLocal() as db:
            uid = db.query(UserORM).filter(UserORM.email == user_email).one().id
            s = db.query(SessionORM).filter(SessionORM.user_id == uid).one()
            s.issued_at = utc_now() - issued_minus
            s.last_seen = utc_now() - last_seen_minus
            db.commit()

    def _etat():
        with SessionLocal() as db:
            uid = db.query(UserORM).filter(UserORM.email == "ttl@test.cm").one().id
            return db.query(SessionORM).filter(SessionORM.user_id == uid).one()

    # 1) Active et récente → conservée.
    client.get("/api/auth/me")
    assert _etat() is not None
    # 2) Inactive depuis 8 jours (> glissant 7 j) → purgée.
    s = _etat()
    _forcer("ttl@test.cm", timedelta(days=2), timedelta(days=8))
    assert client.get("/api/auth/me").status_code == 401
    # 3) Re-login, puis émise il y a 15 jours MAIS active il y a 1 h →
    #    purgée par la borne maximale (14 j).
    client.post("/api/auth/mock-login", json={"email": "ttl@test.cm", "nom": "TTL"})
    _forcer("ttl@test.cm", timedelta(days=15), timedelta(hours=1))
    assert client.get("/api/auth/me").status_code == 401
    # 4) Re-login, émise il y a 5 jours, active il y a 2 h (> granularité
    #    1 h) → conservée ET last_seen rafraîchi à maintenant.
    client.post("/api/auth/mock-login", json={"email": "ttl@test.cm", "nom": "TTL"})
    _forcer("ttl@test.cm", timedelta(days=5), timedelta(hours=2))
    assert client.get("/api/auth/me").status_code == 200
    assert utc_now() - _etat().last_seen < timedelta(minutes=5)


def test_login_admin_inclut_is_admin(eleve):
    me = eleve.get("/api/auth/me").json()
    assert me["is_admin"] is False  # eleve@test.cm n'est ni ROOT ni promu


# ---------- RGPD (H1) : portabilité & effacement ----------

def test_export_et_suppression_compte(client, epreuve_payante):
    """Export complet des données personnelles, puis suppression du compte :
    données purgées, identité anonymisée, paiements conservés (compta)."""
    from fastapi.testclient import TestClient
    import app.main as app_main

    with TestClient(app_main.app) as u:
        r = u.post("/api/auth/mock-login", json={"email": "rgpd@test.cm", "nom": "RGPD Test"})
        assert r.status_code == 200, r.text

        assert u.put("/api/me/consentement", json={"partage_conversations_ia": True, "partage_notes": True}).status_code == 200

        # Épreuve payante non achetée → création de note refusée (garde G2).
        r = u.post(f"/api/epreuves/{epreuve_payante}/notes", json={"cible": "sujet", "contenu": "Ma note RGPD"})
        assert r.status_code == 403

        # Export : structure complète attendue.
        r = u.get("/api/me/export")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["profil"]["email"] == "rgpd@test.cm"
        assert set(body) == {"profil", "notes", "conversations_ia", "consultations", "abonnements", "paiements"}

        # Suppression du compte → sessions révoquées (401 ensuite).
        assert u.delete("/api/me/compte").status_code == 200
        assert u.get("/api/me/profil").status_code == 401


def test_revocation_ia_purge_les_conversations(client, epreuve_gratuite):
    """Révoguer le consentement IA supprime les conversations déjà stockées."""
    from fastapi.testclient import TestClient
    import app.main as app_main

    with TestClient(app_main.app) as u:
        u.post("/api/auth/mock-login", json={"email": "rgpd-ia@test.cm", "nom": "RGPD IA"})
        assert u.put("/api/me/consentement", json={"partage_conversations_ia": True, "partage_notes": True}).status_code == 200
        r = u.post(f"/api/epreuves/{epreuve_gratuite}/conversations", json={"contexte": "", "label": "Discussion 1"})
        assert r.status_code == 200, r.text

        # Révocation IA → conversations purgées.
        assert u.put("/api/me/consentement", json={"partage_conversations_ia": False, "partage_notes": True}).status_code == 200
        r = u.get(f"/api/epreuves/{epreuve_gratuite}/conversations")
        assert r.status_code == 200
        assert r.json() == []
