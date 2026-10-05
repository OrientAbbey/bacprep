"""Assistant admin multi-onglets : résumés, liste blanche d'outils, exécution, audit."""
from __future__ import annotations

import json

import pytest

from app.core import admin_tools
from app.db import SessionLocal
from app.db_models import AdminEventORM, SignalementORM, UserORM


def _exec(admin, outil, args=None):
    return admin.post("/api/admin/assistant/execute", json={"outil": outil, "args": args or {}})


# ---------- sécurité de /execute ----------

def test_execute_reserve_a_l_admin(client, eleve):
    assert client.post("/api/admin/assistant/execute", json={"outil": "plan_creer", "args": {}}).status_code == 401


def test_outil_inconnu_ou_dangereux_refuse(admin):
    for outil in ("utilisateur_supprimer", "utilisateur_promouvoir", "sauvegarde_restaurer", "epreuve_supprimer", "os.system", ""):
        r = _exec(admin, outil, {"id": "x"})
        assert r.status_code == 422, (outil, r.status_code)


def test_aucun_outil_destructif_ni_de_role_dans_le_registre():
    for nom in admin_tools.TOOLS:
        assert not any(mot in nom for mot in ("supprimer", "delete", "restaur", "promouvoir", "demouvoir", "role")), nom


def test_champ_en_trop_refuse(admin):
    r = _exec(admin, "signalement_resoudre", {"id": "abc", "statut": "ouvert"})
    assert r.status_code == 422 and "non autorisés" in r.json()["detail"]


def test_arguments_invalides_refuses_avec_message(admin):
    r = _exec(admin, "plan_creer", {"scope": "matiere", "libelle": "x", "prix": 5, "duree_jours": 10})
    assert r.status_code == 422 and "prix" in r.json()["detail"]
    r = _exec(admin, "evenement_creer", {"titre": "x", "date_debut": "demain"})
    assert r.status_code == 422


# ---------- exécution réelle des outils ----------

def test_plans_et_calendrier_via_assistant(admin, client):
    p = _exec(admin, "plan_creer", {"scope": "matiere", "libelle": "Test assistant", "prix": 900, "duree_jours": 60})
    assert p.status_code == 200, p.text
    pid = p.json()["resultat"]["id"]
    assert _exec(admin, "plan_modifier", {"id": pid, "prix": 950}).json()["resultat"]["prix"] == 950
    assert _exec(admin, "plan_modifier", {"id": "inconnu", "prix": 950}).status_code == 404
    e = _exec(admin, "evenement_creer", {"titre": "Examen assistant", "type": "examen", "date_debut": "2027-05-05"})
    assert e.status_code == 200
    assert any(x["titre"] == "Examen assistant" for x in client.get("/api/calendrier").json())
    admin.delete(f"/api/admin/plans/{pid}")
    admin.delete(f"/api/admin/evenements/{e.json()['resultat']['id']}")


def test_signalement_resolu_via_assistant(admin, epreuve_gratuite):
    with SessionLocal() as db:
        uid = db.query(UserORM.id).first()[0]
        s = SignalementORM(user_id=uid, epreuve_id=epreuve_gratuite, motif="autre", message="coquille", statut="ouvert")
        db.add(s)
        db.commit()
        sid = s.id
    assert _exec(admin, "signalement_resoudre", {"id": sid}).status_code == 200
    with SessionLocal() as db:
        assert db.get(SignalementORM, sid).statut == "resolu"


def test_notification_option_et_epreuve_via_assistant(admin, epreuve_gratuite):
    n = _exec(admin, "notification_creer", {"titre": "Maintenance", "message": "Dimanche 2h", "type": "information"})
    assert n.status_code == 200 and n.json()["resultat"]["titre"] == "Maintenance"
    o = _exec(admin, "option_referentiel_ajouter", {"scope": "serie", "code": "ZZ"})
    assert o.status_code in (200, 409)
    assert _exec(admin, "epreuve_retirer", {"id": epreuve_gratuite}).status_code == 200
    assert _exec(admin, "epreuve_publier", {"id": epreuve_gratuite}).status_code == 200


def test_bannir_et_debannir_via_assistant(admin):
    with SessionLocal() as db:
        from app.db_models import UserORM as U

        cible = U(email="cible-assistant@test.cm", nom="Cible")
        db.add(cible)
        db.commit()
        uid = cible.id
    assert _exec(admin, "utilisateur_bannir", {"id": uid, "motif": "test"}).status_code == 200
    with SessionLocal() as db:
        assert db.get(UserORM, uid).banni is True
    assert _exec(admin, "utilisateur_debannir", {"id": uid}).status_code == 200
    with SessionLocal() as db:
        assert db.get(UserORM, uid).banni is False


def test_sauvegarde_lancee_via_assistant(admin):
    r = _exec(admin, "sauvegarde_lancer")
    assert r.status_code == 200, r.text
    assert r.json()["resultat"].get("job_id") or r.json()["resultat"].get("id")


def test_action_tracee_au_journal(admin):
    _exec(admin, "notification_creer", {"titre": "Trace", "message": ""})
    with SessionLocal() as db:
        ev = db.query(AdminEventORM).filter(AdminEventORM.action == "assistant_action").order_by(AdminEventORM.created_at.desc()).first()
        assert ev is not None
        assert json.loads(ev.details)["outil"] == "notification_creer"


# ---------- lecture : résumés par onglet et confidentialité ----------

@pytest.mark.parametrize("onglet", admin_tools.ONGLETS)
def test_chaque_onglet_a_un_resume(onglet):
    with SessionLocal() as db:
        assert isinstance(admin_tools.resume_onglet(db, onglet), str)


def test_resume_utilisateurs_ne_contient_ni_nom_ni_email_complet(admin):
    with SessionLocal() as db:
        db.add(UserORM(email="marie.dupont@exemple.cm", nom="Marie Dupont"))
        db.commit()
        texte = admin_tools.resume_onglet(db, "utilisateurs")
    assert "marie.dupont@exemple.cm" not in texte and "Dupont" not in texte
    assert "m***@exemple.cm" in texte


def test_invite_onglet_contient_etat_et_outils_et_interdits():
    p = admin_tools.prompt_onglet("formules", "Formules : (x)", "Baisse le prix", [])
    assert "Formules : (x)" in p and "plan_modifier" in p and "N'invente JAMAIS" in p and "ni supprimer" in p


def test_flux_onglet_utilise_le_resume_sans_persister(admin, monkeypatch):
    vus = {}

    async def faux(prompt, images):
        vus["prompt"] = prompt
        yield "Réponse"

    from app.core import assistant as llm

    monkeypatch.setattr(llm, "_stream_gemini", faux)
    r = admin.post("/api/admin/assistant/ask", json={"question": "Combien de formules ?", "onglet": "formules", "epreuve_id": "ignore"})
    assert r.status_code == 200
    assert "Formules d'abonnement" in vus["prompt"] and "Combien de formules ?" in vus["prompt"]
    assert '"conversation": null' in r.text  # la voie « onglet » n'est jamais persistée


def test_onglet_inconnu_retombe_sur_la_voie_epreuve(admin, monkeypatch):
    vus = {}

    async def faux(prompt, images):
        vus["prompt"] = prompt
        yield "ok"

    from app.core import assistant as llm

    monkeypatch.setattr(llm, "_stream_gemini", faux)
    admin.post("/api/admin/assistant/ask", json={"question": "Relis", "onglet": "n-importe-quoi"})
    assert "Épreuve en cours d'édition" in vus["prompt"]
