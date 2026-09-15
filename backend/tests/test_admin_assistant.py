"""Tests du tiroir assistant admin : protection admin, forme du flux SSE,
prompt avec contexte d'épreuve (troncature), comportement sans clé (mode
démonstration) et non-persistance des conversations."""
from __future__ import annotations

import json


def _flux(client, payload: dict) -> list[dict]:
    r = client.post("/api/admin/assistant/ask", json=payload)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")
    events = []
    for line in r.text.splitlines():
        if not line.startswith("data:"):
            continue
        events.append(json.loads(line[len("data:"):].strip()))
    return events


# ---------- Protection admin ----------

def test_requires_admin_session(client):
    """Sans session admin : 401 (visiteur et élève simple confondus)."""
    r = client.post("/api/admin/assistant/ask", json={"question": "Relis ce sujet"})
    assert r.status_code == 401


def test_requires_admin_session_non_admin(eleve):
    r = eleve.post("/api/admin/assistant/ask", json={"question": "Relis ce sujet"})
    assert r.status_code == 401


# ---------- Flux SSE ----------

def test_flux_sse_chunks_puis_done_sans_persistance(admin, monkeypatch):
    """Sans clé LLM configurée, le flux cède un fragment « mode
    démonstration » puis `done` avec `conversation: null` (éphémère : rien
    n'est persisté — la réponse ne contient jamais d'objet conversation)."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    events = _flux(admin, {"question": "Relis ce sujet", "epreuve": {"matiere": "Mathématiques"}})
    assert any(e["type"] == "chunk" and "Mode démonstration" in e["text"] for e in events), events
    done = [e for e in events if e["type"] == "done"]
    assert len(done) == 1
    assert done[0]["conversation"] is None
    assert not any(e["type"] == "error" for e in events)


def test_flux_refuse_question_vide(admin):
    r = admin.post("/api/admin/assistant/ask", json={"question": "   "})
    assert r.status_code == 422


# ---------- Prompt avec contexte d'épreuve ----------

def test_build_admin_prompt_contient_meta_et_contenu():
    from app.core.admin_assistant import build_admin_prompt

    prompt = build_admin_prompt(
        {
            "matiere": "Mathématiques",
            "classe": "terminale",
            "evaluation": "BAC",
            "annee": "2024",
            "session": "Principale",
            "filieres": ["C", "D"],
            "statut": "publie",
            "gratuit": True,
            "contenu_markdown": "# Sujet\n\nRésoudre $x^2 = 4$.",
            "corrige_markdown": "# Corrigé\n\n$x = \\pm 2$.",
        },
        "Peux-tu reformuler ?",
        [{"role": "user", "content": "Peux-tu reformuler ?"}],
    )
    assert "assistant du back-office" in prompt
    assert "Mathématiques" in prompt and "terminale" in prompt
    assert "BAC 2024" in prompt
    assert "SUJET (Markdown brut)" in prompt
    assert "CORRIGÉ (Markdown brut)" in prompt
    assert "$x^2 = 4$" in prompt
    # La question finale n'est pas dupliquée dans l'historique.
    assert prompt.count("Peux-tu reformuler ?") == 1
    # Règle strictes de format présentes (héritées de l'assistant élève).
    assert "$...$" in prompt and "$$...$$" in prompt


def test_build_admin_prompt_tronque_le_contenu():
    from app.core.admin_assistant import build_admin_prompt

    long = "# Sujet\n\n" + ("paragraphe de contrôle " * 2000)
    prompt = build_admin_prompt(
        {"matiere": "M", "annee": "2024", "contenu_markdown": long},
        "Ta question ?",
        [{"role": "user", "content": "Ta question ?"}],
        max_context_chars=500,
    )
    # Le contenu tronqué respecte le plafond (500) une fois isolé de ses
    # en-têtes et de la relance finale.
    bloc = prompt[prompt.index("--- SUJET (Markdown brut) ---"):]
    contenu_slice = bloc[len("--- SUJET (Markdown brut) ---\n"):]
    contenu_isole = contenu_slice.split("\n\nAdmin :")[0]
    assert len(contenu_isole) <= 500


def test_build_admin_prompt_epreuve_vide_et_sans_historique():
    from app.core.admin_assistant import build_admin_prompt

    prompt = build_admin_prompt({}, "Reformule", [])
    assert "(épreuve vide" in prompt
    assert prompt.strip().endswith("Admin : Reformule")


# ---------- Mode démo (aucune clé) ----------

def test_mode_demo_sans_cle(admin, monkeypatch):
    """Sans GEMINI_API_KEY ni GROQ_API_KEY (et avec le LLM mocké), le flux
    retombe sur le mode démonstration — l'endpoint reste sain et termine."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    events = _flux(admin, {"question": "Reformule", "epreuve": {"matiere": "Physique"}})
    assert any(e["type"] == "chunk" and "Mode démonstration" in e["text"] for e in events)
    assert events[-1]["type"] == "done"