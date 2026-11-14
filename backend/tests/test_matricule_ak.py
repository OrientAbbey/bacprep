"""Chantier « matricule + monnaie AK » : génération, série de connexions,
solde, achat en AK, comptabilité et suppression de compte."""
from __future__ import annotations

from app.core import ak
from app.core.matricule import ALPHABET, generer_matricule, est_valide


# --------------------------------------------------------------------------
# Matricule — format et validité
# --------------------------------------------------------------------------

def test_matricule_format_et_alphabet():
    for _ in range(200):
        m = generer_matricule()
        assert est_valide(m), m
        assert m.startswith("CC-")
        prefixe, annee, suffixe = m.split("-")
        assert len(suffixe) == 6
        assert all(c in ALPHABET for c in suffixe)
        # Aucun caractère ambigu : le matricule se dicte au téléphone.
        assert not (set(suffixe) & set("01OIL"))


def test_matricule_annee_injectable_et_deterministe():
    import random

    rng = random.Random(42)
    m1 = generer_matricule(annee=2026, rng=rng)
    rng2 = random.Random(42)
    m2 = generer_matricule(annee=2026, rng=rng2)
    assert m1 == m2 and m1.split("-")[1] == "26"


def test_est_valide_rejette_les_formes_incorrectes():
    assert not est_valide("CC-26-A7K3M")
    assert not est_valide("XX-26-A7K3M9")
    assert not est_valide("CC-2026-A7K3M9")
    assert not est_valide("CC-26-A7K3M0")  # 0 interdit
    assert not est_valide("")
    assert not est_valide(None)  # type inattendu : pas d'exception


# --------------------------------------------------------------------------
# Série de connexions — table de vérité complète
# --------------------------------------------------------------------------

def test_premiere_connexion_donne_3_ak():
    assert ak.calculer_gain_serie(0, None, "2026-11-14") == (1, 3)


def test_paliers_cumulatifs():
    # Jours 1-3 : 3 AK ; 4-6 : 7 AK ; 7+ : 10 AK.
    attendus = [
        (0, 1, 3),
        (1, 2, 3),
        (2, 3, 3),
        (3, 4, 7),
        (4, 5, 7),
        (5, 6, 7),
        (6, 7, 10),
        (7, 8, 10),
        (19, 20, 10),
    ]
    for serie_precedente, nouvelle, gain in attendus:
        assert ak.calculer_gain_serie(serie_precedente, "2026-11-13", "2026-11-14") == (nouvelle, gain)


def test_meme_jour_ne_rapporte_rien():
    assert ak.calculer_gain_serie(4, "2026-11-14", "2026-11-14") == (4, 0)


def test_absence_de_7_jours_remet_la_serie_a_zero():
    assert ak.calculer_gain_serie(6, "2026-11-07", "2026-11-14") == (1, 3)
    assert ak.calculer_gain_serie(9, "2026-01-01", "2026-11-14") == (1, 3)


def test_absence_courte_poursuit_la_serie():
    # 2 à 6 jours d'écart : la série continue (habitude, pas quotidien strict).
    assert ak.calculer_gain_serie(3, "2026-11-12", "2026-11-14") == (4, 7)
    assert ak.calculer_gain_serie(3, "2026-11-08", "2026-11-14") == (4, 7)


def test_date_illisible_ou_future_repart_a_un():
    assert ak.calculer_gain_serie(5, "pas-une-date", "2026-11-14") == (1, 3)
    assert ak.calculer_gain_serie(5, "2026-11-20", "2026-11-14") == (1, 3)


# --------------------------------------------------------------------------
# Matricule exposé et solde persistant
# --------------------------------------------------------------------------

def test_login_cree_un_matricule_et_me_l_expose(visiteur):
    r = visiteur.post("/api/auth/mock-login", json={"email": "ak-matricule@test.cm", "nom": "Test AK"})
    assert r.status_code == 200, r.text
    donnees = r.json()
    assert est_valide(donnees["matricule"])
    assert donnees["solde_ak"] == 3  # première connexion : 3 AK
    assert donnees["ak_serie_jours"] == 1

    me = visiteur.get("/api/auth/me").json()
    assert me["matricule"] == donnees["matricule"]
    assert me["solde_ak"] == 3


def test_deux_connexions_le_meme_jour_ne_crediten_qu_une_fois(visiteur):
    visiteur.post("/api/auth/mock-login", json={"email": "ak-idem@test.cm", "nom": "Idem"})
    second = visiteur.post("/api/auth/mock-login", json={"email": "ak-idem@test.cm", "nom": "Idem"})
    assert second.json()["solde_ak"] == 3


def test_le_matricule_est_unique_par_compte(visiteur):
    a = visiteur.post("/api/auth/mock-login", json={"email": "ak-u1@test.cm", "nom": "U1"}).json()
    b = visiteur.post("/api/auth/mock-login", json={"email": "ak-u2@test.cm", "nom": "U2"}).json()
    assert a["matricule"] != b["matricule"]


# --------------------------------------------------------------------------
# Invariant comptable : solde == somme du journal
# --------------------------------------------------------------------------

def _invariant(db, user_id: str) -> tuple[int, int]:
    from app.db_models import AKMouvementORM, UserORM

    solde = db.query(UserORM).filter(UserORM.id == user_id).one().solde_ak
    total = sum(
        m.montant for m in db.query(AKMouvementORM).filter(AKMouvementORM.user_id == user_id).all()
    )
    return solde, total


def test_solde_egal_somme_des_mouvements(visiteur, db):
    donnees = visiteur.post(
        "/api/auth/mock-login", json={"email": "ak-invariant@test.cm", "nom": "Inv"}
    ).json()
    solde, total = _invariant(db, donnees["id"])
    assert solde == total == 3


def test_credit_et_debit_manuels_restent_coherents(visiteur, db):
    from app.db_models import UserORM

    donnees = visiteur.post(
        "/api/auth/mock-login", json={"email": "ak-flux@test.cm", "nom": "Flux"}
    ).json()
    user = db.query(UserORM).filter(UserORM.id == donnees["id"]).one()

    ak.crediter_ak(db, user, 50, "ajustement_admin")
    assert ak.debiter_ak(db, user, 20, "achat:test") is True
    solde, total = _invariant(db, user.id)
    assert solde == total == 33  # 3 + 50 - 20

    # Débit impossible : refusé, aucune écriture.
    assert ak.debiter_ak(db, user, 10_000, "achat:trop") is False
    assert _invariant(db, user.id) == (33, 33)


def test_debit_superieur_au_solde_refuse(visiteur, db):
    from app.db_models import UserORM

    donnees = visiteur.post(
        "/api/auth/mock-login", json={"email": "ak-pauvre@test.cm", "nom": "Pauvre"}
    ).json()
    user = db.query(UserORM).filter(UserORM.id == donnees["id"]).one()
    assert ak.debiter_ak(db, user, 4, "achat:test") is False
    assert user.solde_ak == 3


# --------------------------------------------------------------------------
# Achat en AK
# --------------------------------------------------------------------------

def _epreuve_payante(admin, matiere: str) -> str:
    r = admin.post(
        "/api/admin/epreuves",
        json={
            "niveau": "SECONDAIRE",
            "classe": "terminale",
            "evaluation": "BAC",
            "matiere": matiere,
            "annee": "2022",
            "gratuit": False,
            "filieres": ["C"],
            "contenu_markdown": "# Sujet AK",
        },
    )
    assert r.status_code == 200, r.text
    eid = r.json()["id"]
    assert admin.post(f"/api/admin/epreuves/{eid}/publish").status_code == 200
    return eid


def test_achat_ak_debite_et_active_immediatement(visiteur, admin, db):
    from app.db_models import PlanORM, SubscriptionORM, UserORM

    eid = _epreuve_payante(admin, "Chimie AK")
    donnees = visiteur.post(
        "/api/auth/mock-login", json={"email": "ak-achat@test.cm", "nom": "Achat"}
    ).json()
    user = db.query(UserORM).filter(UserORM.id == donnees["id"]).one()
    ak.crediter_ak(db, user, 200, "ajustement_admin")

    plan = (
        db.query(PlanORM)
        .filter(PlanORM.scope == "epreuve", PlanORM.actif.is_(True), PlanORM.prix_ak.isnot(None))
        .order_by(PlanORM.ordre)
        .first()
    )
    assert plan is not None, "les formules seedées doivent porter un prix_ak"

    r = visiteur.post(
        "/api/subscriptions/checkout-ak",
        json={"scope": "epreuve", "epreuve_id": eid, "plan_id": plan.id},
    )
    assert r.status_code == 200, r.text
    corps = r.json()
    assert corps["prix_ak"] == plan.prix_ak
    assert corps["solde_ak"] == 203 - plan.prix_ak

    # Souscription active immédiatement (pas de webhook), et tracée en AK.
    sub = db.query(SubscriptionORM).filter(SubscriptionORM.id == corps["subscription_id"]).one()
    assert sub.statut == "active"
    from app.db_models import PaymentORM

    paiement = db.query(PaymentORM).filter(PaymentORM.id == corps["payment_id"]).one()
    assert paiement.monnaie == "AK" and paiement.statut == "confirmed"
    assert paiement.montant == plan.prix_ak


def test_achat_ak_solde_insuffisant(visiteur, admin):
    eid = _epreuve_payante(admin, "Géologie AK")
    visiteur.post("/api/auth/mock-login", json={"email": "ak-fauch@test.cm", "nom": "Fauché"})
    r = visiteur.post("/api/subscriptions/checkout-ak", json={"scope": "epreuve", "epreuve_id": eid})
    assert r.status_code == 402, r.text


def test_achat_ak_formule_non_payable_en_ak_refuse(visiteur, admin, db):
    from app.db_models import PlanORM

    eid = _epreuve_payante(admin, "Botanique AK")
    # Formule dédiée SANS prix_ak, prioritaire sur la formule par défaut.
    pid = admin.post(
        "/api/admin/plans",
        json={"scope": "epreuve", "libelle": "Épreuve FCFA seul", "prix": 400, "duree_jours": 365, "ordre": -1},
    ).json()["id"]
    try:
        visiteur.post("/api/auth/mock-login", json={"email": "ak-sansprix@test.cm", "nom": "SansPrix"})
        r = visiteur.post(
            "/api/subscriptions/checkout-ak",
            json={"scope": "epreuve", "epreuve_id": eid, "plan_id": pid},
        )
        assert r.status_code == 400, r.text
        assert "AK" in r.json()["detail"]
    finally:
        admin.delete(f"/api/admin/plans/{pid}")


# --------------------------------------------------------------------------
# Comptabilité : un achat AK n'est pas un revenu FCFA
# --------------------------------------------------------------------------

def test_achat_ak_ne_pollue_pas_les_totaux_fcfa(visiteur, admin, db):
    from app.db_models import UserORM

    eid = _epreuve_payante(admin, "Statistique AK")
    donnees = visiteur.post(
        "/api/auth/mock-login", json={"email": "ak-compta@test.cm", "nom": "Compta"}
    ).json()
    user = db.query(UserORM).filter(UserORM.id == donnees["id"]).one()
    ak.crediter_ak(db, user, 500, "ajustement_admin")

    stats_avant = admin.get("/api/admin/stats").json()["revenu_total_fcfa"]
    profil_avant = visiteur.get("/api/me/profil").json()["total_depense_fcfa"]

    r = visiteur.post("/api/subscriptions/checkout-ak", json={"scope": "epreuve", "epreuve_id": eid})
    assert r.status_code == 200, r.text

    assert admin.get("/api/admin/stats").json()["revenu_total_fcfa"] == stats_avant
    assert visiteur.get("/api/me/profil").json()["total_depense_fcfa"] == profil_avant

    # Mais le journal AK, lui, a bien enregistré le débit.
    motifs = [m["motif"] for m in visiteur.get("/api/me/profil").json()["ak_mouvements"]]
    assert any(m.startswith("achat:") for m in motifs)


# --------------------------------------------------------------------------
# Suppression de compte : pas de FOREIGN KEY constraint failed
# --------------------------------------------------------------------------

def test_suppression_compte_purge_le_journal_ak(visiteur, db):
    donnees = visiteur.post(
        "/api/auth/mock-login", json={"email": "ak-suppr@test.cm", "nom": "Suppr"}
    ).json()
    from app.db_models import AKMouvementORM

    assert db.query(AKMouvementORM).filter(AKMouvementORM.user_id == donnees["id"]).count() == 1

    r = visiteur.delete("/api/me/compte")
    assert r.status_code == 200, r.text
    assert db.query(AKMouvementORM).filter(AKMouvementORM.user_id == donnees["id"]).count() == 0


def test_suppression_admin_purge_le_journal_ak(visiteur, admin, db):
    donnees = visiteur.post(
        "/api/auth/mock-login", json={"email": "ak-suppr-admin@test.cm", "nom": "SupprAdmin"}
    ).json()
    from app.db_models import AKMouvementORM

    assert db.query(AKMouvementORM).filter(AKMouvementORM.user_id == donnees["id"]).count() == 1

    r = admin.delete(f"/api/admin/utilisateurs/{donnees['id']}")
    assert r.status_code == 200, r.text
    assert db.query(AKMouvementORM).filter(AKMouvementORM.user_id == donnees["id"]).count() == 0


# --------------------------------------------------------------------------
# Export RGPD et back-office
# --------------------------------------------------------------------------

def test_export_contient_matricule_et_journal_ak(visiteur):
    donnees = visiteur.post(
        "/api/auth/mock-login", json={"email": "ak-export@test.cm", "nom": "Export"}
    ).json()
    export = visiteur.get("/api/me/export").json()
    assert export["profil"]["matricule"] == donnees["matricule"]
    assert export["profil"]["solde_ak"] == 3
    assert len(export["ak_mouvements"]) == 1
    assert export["ak_mouvements"][0]["montant"] == 3


def test_admin_liste_expose_matricule_et_filtre(visiteur, admin):
    donnees = visiteur.post(
        "/api/auth/mock-login", json={"email": "ak-adminlist@test.cm", "nom": "AdminList"}
    ).json()
    lignes = admin.get("/api/admin/utilisateurs").json()
    ligne = next(ligne for ligne in lignes if ligne["id"] == donnees["id"])
    assert ligne["matricule"] == donnees["matricule"]
    assert ligne["solde_ak"] == 3

    filtre = admin.get("/api/admin/utilisateurs", params={"matricule": donnees["matricule"]}).json()
    assert [ligne["id"] for ligne in filtre] == [donnees["id"]]
