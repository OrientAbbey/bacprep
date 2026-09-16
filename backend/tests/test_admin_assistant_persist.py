"""Tests de la voie PERSISTÉE de l'assistant admin : création,
réconciliation server-side, suppression (« Nouvelle conversation »)
et garantie que chaque admin a sa propre conversation roulante.
"""
from __future__ import annotations

import json

import pytest

from app.db_models import AdminAIConversationORM


# ---------- Helpers ----------

def _ask(client, question: str, epreuve_id: str = "epr-001", historique: list | None = None) -> list[dict]:
    payload = {
        "question": question,
        "epreuve_id": epreuve_id,
        "epreuve": {"matiere": "Mathématiques"},
        "historique": historique or [],
    }
    r = client.post("/api/admin/assistant/ask", json=payload)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")
    events = []
    for line in r.text.splitlines():
        if not line.startswith("data:"):
            continue
        events.append(json.loads(line[len("data:"):].strip()))
    return events


def _get_conv(client, epreuve_id: str = "epr-001") -> dict | None:
    r = client.get(f"/api/admin/assistant/conversation/{epreuve_id}")
    assert r.status_code == 200
    return r.json().get("conversation")


def _delete_conv(client, epreuve_id: str = "epr-001") -> None:
    r = client.delete(f"/api/admin/assistant/conversation/{epreuve_id}")
    assert r.status_code == 200
    assert r.json().get("ok") is True


# ---------- Voie éphémère (sans epreuve_id) ----------

def test_ephemere_sans_persistance(admin, monkeypatch):
    """Sans `epreuve_id` : `done.conversation` est null, aucune ligne en base."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    events = _flux(admin, "Q")
    done = [e for e in events if e["type"] == "done"]
    assert len(done) == 1
    assert done[0]["conversation"] is None
    from app.db import SessionLocal
    with SessionLocal() as db:
        assert db.query(AdminAIConversationORM).count() == 0


def _flux(client, question: str) -> list[dict]:
    r = client.post("/api/admin/assistant/ask", json={"question": question, "epreuve": {}})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    events = []
    for line in r.text.splitlines():
        if line.startswith("data:"):
            events.append(json.loads(line[len("data:"):].strip()))
    return events


# ---------- Persistance avec epreuve_id ----------

def test_persistance_premiere_question_cree_conversation(admin, monkeypatch):
    """La première question avec `epreuve_id` crée une conversation en base
    et `done.conversation` la restitue (au minimum 2 messages : user + assistant)."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    events = _ask(admin, "Donne le plan du sujet", epreuve_id="pers-001")
    done = [e for e in events if e["type"] == "done"]
    assert len(done) == 1
    conv = done[0]["conversation"]
    assert conv is not None
    assert conv["id"]
    assert conv["epreuve_id"] == "pers-001"
    # Le dernier message est l'assistant (réponse démo), l'avant-dernier est user.
    msgs = conv["messages"]
    assert len(msgs) >= 2
    assert msgs[-2]["role"] == "user"
    assert msgs[-2]["content"] == "Donne le plan du sujet"
    assert msgs[-1]["role"] == "assistant"


def test_get_conversation_retrouve_apres_premiere_question(admin, monkeypatch):
    """GET renvoie la même conversation que celle restituée par done."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    events = _ask(admin, "Q2", epreuve_id="pers-002")
    done = [e for e in events if e["type"] == "done"][0]
    conv_done = done["conversation"]
    conv_get = _get_conv(admin, "pers-002")
    assert conv_get is not None
    assert conv_get["id"] == conv_done["id"]
    assert len(conv_get["messages"]) == len(conv_done["messages"])


def test_get_conversation_absente_retourne_null(admin):
    """GET sur une épreuve jamais discutée renvoie null."""
    assert _get_conv(admin, "pers-inexistant") is None


# ---------- Réconciliation ----------

def test_reconciliation_si_historique_different(admin, monkeypatch):
    """Le serveur réconcilie les messages persistés avec l'historique fourni :
    si un résidu de tentative interrompue subsiste côté serveur mais que le
    client renvoie l'historique d'origine, le résidu est écrasé et l'ancien
    message user n'est pas dupliqué."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    # 1ère question
    events1 = _ask(admin, "Q réconciliée", epreuve_id="pers-reconcil")
    conv1 = [e for e in events1 if e["type"] == "done"][0]["conversation"]
    user1_msgs = [m for m in conv1["messages"] if m["role"] == "user"]
    assert len(user1_msgs) == 1

    # 2ème question avec historique = réponse du serveur (base attendue)
    base = conv1["messages"]
    base_dicts = [{"role": m["role"], "content": m["content"], "ts": m["ts"]} for m in base]
    events2 = _ask(admin, "Q réconciliée 2", epreuve_id="pers-reconcil", historique=base_dicts)
    conv2 = [e for e in events2 if e["type"] == "done"][0]["conversation"]
    user_msgs = [m for m in conv2["messages"] if m["role"] == "user"]
    assert len(user_msgs) == 2
    assert user_msgs[1]["content"] == "Q réconciliée 2"


# ---------- Suppression ----------

def test_delete_conversation_efface(admin, monkeypatch):
    """DELETE supprime la conversation ; GET retourne ensuite null."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    _ask(admin, "A supprimer", epreuve_id="pers-del")
    assert _get_conv(admin, "pers-del") is not None
    _delete_conv(admin, "pers-del")
    assert _get_conv(admin, "pers-del") is None


def test_delete_conversation_inexistante_ne_fait_rien(admin):
    """DELETE sur une épreuve jamais discutée ne provoque pas d'erreur."""
    _delete_conv(admin, "pers-del-fantom")


# ---------- Isolation par admin ----------

def test_reutilise_la_meme_conversation_et_accroit(admin, monkeypatch):
    """Deux questions successives sur la même épreuve réutilisent la MÊME
    conversation (chaque `historique` envoyé = la base courante) et
    l'accumulent : l'id ne change pas et le nombre de messages augmente."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    _ask(admin, "Admin1 Q", epreuve_id="pers-iso")
    conv1 = _get_conv(admin, "pers-iso")
    # 2e question : base = la conversation mémorisée (le client renvoie son
    # historique complet, comme le panneau le fait réellement).
    base = [{"role": m["role"], "content": m["content"], "ts": m["ts"]} for m in conv1["messages"]]
    _ask(admin, "Admin1 Q2", epreuve_id="pers-iso", historique=base)
    conv2 = _get_conv(admin, "pers-iso")
    assert conv1 is not None and conv2 is not None
    assert conv1["id"] == conv2["id"]
    # L'historique a bien grandi : 2 échanges (4 messages).
    assert len(conv2["messages"]) == len(conv1["messages"]) + 2
    assert conv2["messages"][-2]["content"] == "Admin1 Q2"
