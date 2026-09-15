"""Horodatage des messages de discussion : chaque message persisté porte un
`ts` ISO (affiché HH:MM côté frontend)."""
from __future__ import annotations

import json


def _conversation(eleve, epreuve_gratuite) -> str:
    r = eleve.post(
        f"/api/epreuves/{epreuve_gratuite}/conversations",
        json={"contexte": "", "label": "Horodatage"},
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_ask_non_streaming_horodate_les_messages(eleve, epreuve_gratuite):
    """`/api/assistant/ask` : question et réponse persistent avec un `ts`."""
    conv_id = _conversation(eleve, epreuve_gratuite)
    r = eleve.post("/api/assistant/ask", json={"conversation_id": conv_id, "message": "Que vaut 2+2 ?"})
    assert r.status_code == 200, r.text
    messages = r.json()["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant"]
    for m in messages:
        assert isinstance(m.get("ts"), str) and m["ts"]


def test_ask_stream_persiste_les_messages_horodates(eleve, epreuve_gratuite):
    """`/api/assistant/ask/stream` (persistée) : l'évènement final `done`
    porte la discussion avec chaque message horodaté."""
    conv_id = _conversation(eleve, epreuve_gratuite)
    r = eleve.post(
        "/api/assistant/ask/stream",
        json={"conversation_id": conv_id, "message": "Que vaut 3+3 ?"},
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")
    done = None
    for line in r.text.splitlines():
        if not line.startswith("data:"):
            continue
        event = json.loads(line[len("data:"):].strip())
        if event["type"] == "done":
            done = event["conversation"]
    assert done is not None
    messages = done["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant"]
    for m in messages:
        assert isinstance(m.get("ts"), str) and m["ts"]


def test_anciens_messages_sans_ts_restent_acceptes(eleve, epreuve_gratuite):
    """Rétro-compatibilité : un historique sans `ts` (messages stockés avant
    le changement) reste accepté par l'API et l'échange suivant fonctionne."""
    conv_id = _conversation(eleve, epreuve_gratuite)
    # Remplace les messages par un ancien format (sans ts).
    r = eleve.put(
        f"/api/epreuves/{epreuve_gratuite}/conversations/{conv_id}",
        json={"messages": [{"role": "user", "content": "question héritée"}]},
    )
    assert r.status_code == 200, r.text
    r = eleve.post("/api/assistant/ask", json={"conversation_id": conv_id, "message": "Encore une ?"})
    assert r.status_code == 200, r.text
    messages = r.json()["messages"]
    assert messages[0]["content"] == "question héritée"
    # Les nouveaux messages portent le ts ; l'ancien en est exempt.
    assert "ts" not in messages[0]
    assert all("ts" in m for m in messages[1:])