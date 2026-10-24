"""Assistant admin d'édition : tous les sujets visibles, modifications ciblées, mémoire des brouillons."""
from __future__ import annotations

from app.core.admin_assistant import build_admin_prompt


def _prompt(meta, **kw):
    return build_admin_prompt(meta, "Corrige", [{"role": "user", "content": "Corrige"}], **kw)


def test_prompt_expose_tous_les_sujets_numerotes_contenu_non_enregistre_compris():
    meta = {"matiere": "Maths", "sujets": [
        {"index": 0, "contenu_markdown": "Sujet un ALPHA", "corrige_markdown": "Corrigé un"},
        {"index": 1, "contenu_markdown": "Sujet deux BETA", "corrige_markdown": ""},
        {"index": 2, "contenu_markdown": "", "corrige_markdown": ""},
    ]}
    p = _prompt(meta)
    assert "--- SUJET 1 (Markdown brut) ---" in p and "ALPHA" in p
    assert "--- SUJET 2 (Markdown brut) ---" in p and "BETA" in p
    assert "--- CORRIGÉ 1 (Markdown brut) ---" in p and "--- CORRIGÉ 2" not in p  # pas de corrigé vide
    assert "--- SUJET 3 (Markdown brut) ---\n(vide)" in p


def test_un_seul_sujet_garde_le_format_historique():
    p = _prompt({"sujets": [{"index": 0, "contenu_markdown": "Seul", "corrige_markdown": "Sa solution"}]})
    assert "--- SUJET (Markdown brut) ---\nSeul" in p and "--- CORRIGÉ (Markdown brut) ---\nSa solution" in p
    assert "SUJET 1" not in p


def test_troncature_des_sujets_multiples_est_signalee():
    meta = {"sujets": [{"index": i, "contenu_markdown": "mot " * 400, "corrige_markdown": ""} for i in range(3)]}
    p = _prompt(meta, max_context_chars=600)
    assert "[… contenu tronqué …]" in p


def test_le_prompt_decrit_les_modifications_ciblees_et_la_reecriture():
    p = _prompt({})
    for attendu in ("remplacer-sujet:N", "remplacer-corrige:N", "<<<<<<< CHERCHER", "=======", ">>>>>>> REMPLACER",
                    "modification-sujet:N", "MOT POUR MOT", "AJOUTER à la fin", "SUPPRIMER"):
        assert attendu in p, attendu


def test_le_prompt_indique_le_sujet_affiche_dans_l_editeur():
    assert "Sujet affiché dans l'éditeur : sujet 2." in _prompt({"sujet_actif": 2})
    assert "Sujet affiché dans l'éditeur" not in _prompt({})
    assert "Sujet affiché dans l'éditeur" not in _prompt({"sujet_actif": "x"})  # valeur inattendue ignorée


def test_conversation_de_brouillon_rattachee_a_l_epreuve_enregistree(admin, monkeypatch):
    from app.core import assistant as llm

    async def faux(prompt, images):
        yield "ok"

    monkeypatch.setattr(llm, "_stream_gemini", faux)
    cle = "brouillon:test-abc"
    r = admin.post("/api/admin/assistant/ask", json={"question": "Aide", "epreuve_id": cle, "epreuve": {"matiere": "M"}})
    assert r.status_code == 200 and '"conversation": null' not in r.text
    assert admin.get(f"/api/admin/assistant/conversation/{cle}").json()["conversation"] is not None
    assert admin.post(f"/api/admin/assistant/conversation/{cle}/deplacer", json={"vers": "ep-reel-1"}).json() == {"ok": True}
    assert admin.get(f"/api/admin/assistant/conversation/{cle}").json()["conversation"] is None
    suivi = admin.get("/api/admin/assistant/conversation/ep-reel-1").json()["conversation"]
    assert suivi and suivi["messages"][0]["content"] == "Aide"
    # rien à déplacer / cible déjà occupée : sans effet, sans erreur
    assert admin.post(f"/api/admin/assistant/conversation/{cle}/deplacer", json={"vers": "x"}).json() == {"ok": False}
    admin.delete("/api/admin/assistant/conversation/ep-reel-1")


def test_deplacer_reserve_a_l_admin(client):
    assert client.post("/api/admin/assistant/conversation/a/deplacer", json={"vers": "b"}).status_code in (401, 403)


def test_brouillons_abandonnes_effaces_apres_30_jours(client, db):
    from datetime import timedelta

    from app.core import store
    from app.db import utc_now
    from app.db_models import AdminAIConversationORM

    ancien = store.create_admin_conversation(db, "a@x.cm", "brouillon:vieux")
    store.create_admin_conversation(db, "a@x.cm", "brouillon:recent")
    autre_admin = store.create_admin_conversation(db, "b@x.cm", "brouillon:vieux-b")
    onglet = store.create_admin_conversation(db, "a@x.cm", "onglet:formules")
    for c in (ancien, autre_admin, onglet):
        c.updated_at = utc_now() - timedelta(days=40)
    db.commit()
    store.create_admin_conversation(db, "a@x.cm", "brouillon:nouveau")
    restantes = {c.epreuve_id for c in db.query(AdminAIConversationORM).filter(AdminAIConversationORM.email.in_(["a@x.cm", "b@x.cm"]))}
    assert restantes == {"brouillon:recent", "brouillon:vieux-b", "onglet:formules", "brouillon:nouveau"}
    db.query(AdminAIConversationORM).filter(AdminAIConversationORM.email.in_(["a@x.cm", "b@x.cm"])).delete(synchronize_session=False)
    db.commit()
