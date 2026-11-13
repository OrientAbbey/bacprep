"""Entraînement : routes publiques (variantes sans réponses, correction à part, signalement) et back-office (validation liée au hash, aperçu, signalements).

Les vrais gabarits livrés (app/gabarits/) servent de données. Les gabarits « cassés » ou « modifiés » sont injectés en remplaçant le cache de `gabarits.tous()`."""
from __future__ import annotations

import copy
import json

import pytest

from app.core import gabarits as g

GID = "derivee-polynome-degre-3"
URL = "/api/entrainement/gabarits"
ADM = "/api/admin/gabarits"


@pytest.fixture(autouse=True)
def _etat_propre(client, monkeypatch):  # `client` : son démarrage crée les tables
    """La base de test est partagée par toute la session : validations, signalements et événements d'audit des gabarits sont purgés avant CHAQUE test, et le cache
    de chargement est restauré après (certains tests y injectent un gabarit modifié ou cassé)."""
    from app.db import SessionLocal
    from app.db_models import AdminEventORM, GabaritSignalementORM, GabaritValidationORM
    from app.routers import entrainement

    with SessionLocal() as s:
        s.query(GabaritValidationORM).delete()
        s.query(GabaritSignalementORM).delete()
        s.query(AdminEventORM).filter(AdminEventORM.action.like("gabarit%")).delete(synchronize_session=False)
        s.commit()
    entrainement._limiter._attempts.clear()
    entrainement._signal_limiter._attempts.clear()
    monkeypatch.setattr(g, "_CACHE", g.charger_dossier())


def _remplacer(monkeypatch, gid: str, **modif) -> g.Gabarit:
    valides, erreurs = g.charger_dossier()
    raw = copy.deepcopy(valides[gid].brut)
    for cle, val in modif.items():
        raw[cle] = val
    nouveau = g.Gabarit(raw)
    valides[gid] = nouveau
    monkeypatch.setattr(g, "_CACHE", (valides, erreurs))
    return nouveau


def valider(admin, gid: str = GID):
    r = admin.post(f"{ADM}/{gid}/validation")
    assert r.status_code == 200, r.text


# --- Public -----------------------------------------------------------------------------------------------------------------

def test_rien_n_est_public_avant_validation(visiteur, admin):
    assert visiteur.get(URL).json() == []
    assert visiteur.get(f"{URL}/{GID}").status_code == 404
    assert visiteur.get(f"{URL}/{GID}/correction?graine=1").status_code == 404
    assert visiteur.get(f"{URL}/{GID}").json()["detail"] == "Exercice introuvable"


def test_liste_des_gabarits_valides(visiteur, admin):
    valider(admin)
    valider(admin, "suite-arithmetique")
    liste = visiteur.get(URL).json()
    assert {x["id"] for x in liste} == {GID, "suite-arithmetique"}
    assert set(liste[0]) == {"id", "titre", "matiere", "classes", "chapitre", "difficulte", "total_points"}
    assert [(x["matiere"], x["chapitre"]) for x in liste] == sorted((x["matiere"], x["chapitre"]) for x in liste)


def test_variante_deterministe_et_sans_reponses(visiteur, admin):
    valider(admin)
    r1, r2 = visiteur.get(f"{URL}/{GID}?graine=123"), visiteur.get(f"{URL}/{GID}?graine=123")
    assert r1.status_code == 200 and r1.json() == r2.json()
    corps = r1.json()
    assert set(corps) == {"id", "titre", "graine", "enonce", "questions", "total_points"} and corps["graine"] == 123
    inst = g.tous()[0][GID].instancier(123)
    assert corps["enonce"] == inst["enonce"] and [q["enonce"] for q in corps["questions"]] == [q["enonce"] for q in inst["questions"]]
    texte = json.dumps(corps, ensure_ascii=False)
    assert all(c["reponse"] not in texte and c["etapes"] not in texte for c in inst["corrections"])
    assert visiteur.get(f"{URL}/{GID}?graine=124").json() != corps


def test_sans_graine_le_serveur_en_tire_une(visiteur, admin):
    valider(admin)
    graines = {visiteur.get(f"{URL}/{GID}").json()["graine"] for _ in range(6)}
    assert len(graines) >= 2 and all(0 <= x <= g.GRAINE_MAX for x in graines)
    rejouee = visiteur.get(f"{URL}/{GID}?graine={next(iter(graines))}").json()
    assert rejouee["graine"] == next(iter(graines))  # la graine rendue suffit à retrouver la variante


@pytest.mark.parametrize("graine", ["-1", str(g.GRAINE_MAX + 1), "abc", "1.5", ""])
def test_graine_invalide_422(visiteur, admin, graine):
    valider(admin)
    assert visiteur.get(f"{URL}/{GID}?graine={graine}").status_code == 422
    assert visiteur.get(f"{URL}/{GID}/correction?graine={graine}").status_code == 422


def test_correction_a_part_et_exacte(visiteur, admin):
    valider(admin)
    r = visiteur.get(f"{URL}/{GID}/correction?graine=77")
    assert r.status_code == 200
    assert r.json() == g.vue_correction(g.tous()[0][GID].instancier(77))
    assert visiteur.get(f"{URL}/{GID}/correction").status_code == 422  # la graine est obligatoire


def test_id_inconnu_ou_etrange(visiteur, admin):
    valider(admin)
    for mauvais in ("inconnu", "..%2F..%2Fetc%2Fpasswd", "DERIVEE", "x" * 200):
        assert visiteur.get(f"{URL}/{mauvais}").status_code == 404


def test_gabarit_modifie_cesse_d_etre_public_jusqu_a_revalidation(visiteur, admin, monkeypatch):
    valider(admin)
    assert visiteur.get(f"{URL}/{GID}?graine=1").status_code == 200
    _remplacer(monkeypatch, GID, titre="Titre modifié après validation")
    assert visiteur.get(f"{URL}/{GID}?graine=1").status_code == 404 and visiteur.get(URL).json() == []
    ligne = next(x for x in admin.get(ADM).json()["gabarits"] if x["id"] == GID)
    assert ligne["statut"] == "modifie"
    valider(admin)
    assert visiteur.get(f"{URL}/{GID}?graine=1").json()["titre"] == "Titre modifié après validation"


def test_limite_de_debit_public(visiteur, admin, monkeypatch):
    from app.routers import entrainement

    valider(admin)
    monkeypatch.setenv("ENTRAINEMENT_RATE_LIMIT", "1")
    monkeypatch.setattr(entrainement._limiter, "_max", 3)
    entrainement._limiter._attempts.clear()
    codes = [visiteur.get(f"{URL}/{GID}?graine=1").status_code for _ in range(4)]
    entrainement._limiter._attempts.clear()
    assert codes == [200, 200, 200, 429]


# --- Signalement ------------------------------------------------------------------------------------------------------------

def test_signalement_exige_une_session(visiteur, admin):
    valider(admin)
    assert visiteur.post(f"{URL}/{GID}/signalements", json={"graine": 5, "message": "faux"}).status_code == 401


def test_signalement_et_doublon(eleve, admin, db):
    from app.db_models import GabaritSignalementORM

    valider(admin)
    r = eleve.post(f"{URL}/{GID}/signalements", json={"graine": 5, "message": "  la correction est fausse  "})
    assert r.status_code == 200 and r.json()["ok"]
    ligne = db.query(GabaritSignalementORM).one()
    assert (ligne.gabarit_id, ligne.graine, ligne.message, ligne.statut) == (GID, 5, "la correction est fausse", "ouvert")
    doublon = eleve.post(f"{URL}/{GID}/signalements", json={"graine": 5, "message": "encore"})
    assert doublon.status_code == 409 and "déjà signalé" in doublon.json()["detail"]
    assert eleve.post(f"{URL}/{GID}/signalements", json={"graine": 6, "message": "autre variante"}).status_code == 200  # autre variante : permis


@pytest.mark.parametrize("corps", [{"graine": -1}, {"graine": g.GRAINE_MAX + 1}, {"graine": 1, "message": "x" * 1001}, {"message": "pas de graine"}])
def test_signalement_entrees_invalides(eleve, admin, corps):
    valider(admin)
    assert eleve.post(f"{URL}/{GID}/signalements", json=corps).status_code == 422


def test_signalement_d_un_gabarit_non_valide_refuse(eleve):
    assert eleve.post(f"{URL}/{GID}/signalements", json={"graine": 1}).status_code == 404


def test_limite_de_signalements(eleve, admin, monkeypatch):
    from app.routers import entrainement

    valider(admin)
    monkeypatch.setenv("ENTRAINEMENT_RATE_LIMIT", "1")
    entrainement._signal_limiter._attempts.clear()
    codes = [eleve.post(f"{URL}/{GID}/signalements", json={"graine": i}).status_code for i in range(11)]
    entrainement._signal_limiter._attempts.clear()
    assert codes[:10] == [200] * 10 and codes[10] == 429


# --- Back-office --------------------------------------------------------------------------------------------------------------

def test_back_office_reserve_aux_administrateurs(visiteur, eleve):
    routes = [("get", ADM), ("get", f"{ADM}/signalements"), ("get", f"{ADM}/{GID}/apercu"), ("post", f"{ADM}/{GID}/validation"),
              ("delete", f"{ADM}/{GID}/validation"), ("post", f"{ADM}/signalements/abc/resoudre")]
    for client in (visiteur, eleve):
        for methode, url in routes:
            assert getattr(client, methode)(url).status_code == 401, (methode, url)


def test_liste_back_office(admin):
    corps = admin.get(ADM).json()
    assert corps["fichiers_invalides"] == {} and len(corps["gabarits"]) >= 11
    ligne = next(x for x in corps["gabarits"] if x["id"] == GID)
    assert ligne["statut"] == "a_valider" and ligne["valide_par"] is None and ligne["signalements_ouverts"] == 0
    assert ligne["rapport"]["ok"] and ligne["rapport"]["n"] == 100 and ligne["total_points"] == 5.0


def test_validation_et_audit(admin, db):
    from app.db_models import AdminEventORM

    valider(admin)
    ligne = next(x for x in admin.get(ADM).json()["gabarits"] if x["id"] == GID)
    assert ligne["statut"] == "valide" and ligne["valide_par"] == "admin@example.com" and ligne["valide_le"]
    ev = db.query(AdminEventORM).filter(AdminEventORM.action == "gabarit_valide").one()
    assert json.loads(ev.details)["gabarit"] == GID and ev.epreuve_id is None
    valider(admin)  # idempotent
    assert db.query(AdminEventORM).filter(AdminEventORM.action == "gabarit_valide").count() == 2


def test_validation_refusee_si_le_rapport_automatique_echoue(admin, monkeypatch):
    _remplacer(monkeypatch, "suite-arithmetique", enonce="Soit {{1/(n - n)}}")
    r = admin.post(f"{ADM}/suite-arithmetique/validation")
    assert r.status_code == 409 and "contrôle automatique" in r.json()["detail"]
    ligne = next(x for x in admin.get(ADM).json()["gabarits"] if x["id"] == "suite-arithmetique")
    assert ligne["statut"] == "a_valider" and not ligne["rapport"]["ok"]


def test_retirer_la_validation(admin, visiteur, db):
    from app.db_models import AdminEventORM

    valider(admin)
    assert admin.delete(f"{ADM}/{GID}/validation").status_code == 200
    assert visiteur.get(URL).json() == []
    assert next(x for x in admin.get(ADM).json()["gabarits"] if x["id"] == GID)["statut"] == "a_valider"
    assert db.query(AdminEventORM).filter(AdminEventORM.action == "gabarit_validation_retiree").count() == 1
    assert admin.delete(f"{ADM}/{GID}/validation").status_code == 200  # sans effet, sans nouvel événement
    assert db.query(AdminEventORM).filter(AdminEventORM.action == "gabarit_validation_retiree").count() == 1


def test_gabarit_inconnu_404(admin):
    assert admin.post(f"{ADM}/inconnu/validation").status_code == 404
    assert admin.delete(f"{ADM}/inconnu/validation").status_code == 404
    assert admin.get(f"{ADM}/inconnu/apercu").status_code == 404
    assert admin.get(f"{ADM}/inconnu/apercu").json()["detail"] == "Gabarit introuvable"


def test_apercu_avec_correction_meme_non_valide(admin):
    r = admin.get(f"{ADM}/{GID}/apercu?graine=9")
    assert r.status_code == 200
    assert r.json() == g.tous()[0][GID].instancier(9) and r.json()["corrections"]
    assert admin.get(f"{ADM}/{GID}/apercu?graine=-3").status_code == 422
    assert admin.get(f"{ADM}/{GID}/apercu").json()["graine"] >= 0


def test_apercu_d_une_graine_qui_echoue_422(admin, monkeypatch):
    _remplacer(monkeypatch, "suite-arithmetique", questions=[{"enonce": "{{1/(n % 2)}}", "reponse": "r", "etapes": "e", "points": 1}])  # échoue quand n est pair
    ech = [s for s in range(60) if admin.get(f"{ADM}/suite-arithmetique/apercu?graine={s}").status_code == 422]
    assert 10 < len(ech) < 50 and "échoue" in admin.get(f"{ADM}/suite-arithmetique/apercu?graine={ech[0]}").json()["detail"]


def test_signalements_back_office(eleve, admin):
    valider(admin)
    eleve.post(f"{URL}/{GID}/signalements", json={"graine": 11, "message": "la tangente est fausse"})
    assert next(x for x in admin.get(ADM).json()["gabarits"] if x["id"] == GID)["signalements_ouverts"] == 1
    liste = admin.get(f"{ADM}/signalements").json()
    assert len(liste) == 1 and liste[0]["graine"] == 11 and liste[0]["email"] == "eleve@test.cm" and liste[0]["titre"] == g.tous()[0][GID].titre
    assert admin.post(f"{ADM}/signalements/{liste[0]['id']}/resoudre").status_code == 200
    assert admin.get(f"{ADM}/signalements").json() == []
    assert admin.get(f"{ADM}/signalements?statut=resolu").json()[0]["statut"] == "resolu"
    assert next(x for x in admin.get(ADM).json()["gabarits"] if x["id"] == GID)["signalements_ouverts"] == 0
    assert admin.post(f"{ADM}/signalements/inconnu/resoudre").status_code == 404
    assert admin.get(f"{ADM}/signalements?statut=nimporte").status_code == 422
    # l'élève peut signaler de nouveau la même variante une fois le premier signalement traité
    assert eleve.post(f"{URL}/{GID}/signalements", json={"graine": 11}).status_code == 200


def test_export_et_suppression_de_compte_couvrent_les_signalements(eleve, admin, db):
    from app.db_models import GabaritSignalementORM

    valider(admin)
    eleve.post(f"{URL}/{GID}/signalements", json={"graine": 3, "message": "erreur"})
    export = eleve.get("/api/me/export").json()
    assert [(s["gabarit_id"], s["graine"], s["message"]) for s in export["signalements_exercices"]] == [(GID, 3, "erreur")]
    assert eleve.delete("/api/me/compte").status_code == 200
    db.expire_all()
    assert db.query(GabaritSignalementORM).count() == 0
