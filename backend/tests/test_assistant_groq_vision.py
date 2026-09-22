"""Images transmises à Groq Vision et suppression du mode démo en prod.

Contexte (prod, 2026-09-22) : sans clé GEMINI, une épreuve avec images
retombait sur le mode démonstration — Gemini était le seul chemin
multimodal. Or Groq possède des modèles VISION (qwen/qwen3.8-27b, vérifié
en direct avec une image 64x64) : les images doivent être transmises en
`image_url` (data URI), et le CSS/format OpenAI est rejeté par les modèles
texte seul ("content must be a string"). Deux correctifs :
  - `_groq_content` : liste de parts texte + images pour les modèles Vision,
    texte simple avec note pour les autres ; `_groq_models_ordonnes` met les
    modèles Vision EN PREMIER quand des images sont présentes.
  - En production (`ENV=prod`), plus AUCUNE réponse simulée : erreur
    `FournisseursIndisponiblesError` (le routeur renvoie 503 ou un
    évènement SSE error honnête)."""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path

import httpx
import pytest

PNG_ROND = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="


def _png_tmp(tmp_path: Path) -> Path:
    p = tmp_path / "image.png"
    p.write_bytes(base64.b64decode(PNG_ROND))
    return p


def _collecteur(agen) -> list[str]:
    morceaux: list[str] = []

    async def _inner():
        async for c in agen:
            morceaux.append(c)

    asyncio.run(_inner())
    return morceaux


# --- `_groq_content` : images selon le modèle ----------------------------

def test_groq_content_vision_inclut_les_images(tmp_path):
    from app.core import assistant

    p = _png_tmp(tmp_path)
    content = assistant._groq_content("qwen/qwen3.8-27b", "Décris", [p])
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "Décris"}
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_groq_content_modele_texte_seul_garde_la_note(tmp_path):
    from app.core import assistant

    p = _png_tmp(tmp_path)
    content = assistant._groq_content("openai/gpt-oss-20b", "Décris", [p])
    assert isinstance(content, str)
    assert "image(s)" in content  # la note signale les images ignorées
    assert "image_url" not in content


def test_groq_content_sans_image_reste_un_texte():
    from app.core import assistant

    content = assistant._groq_content("qwen/qwen3.8-27b", "Bonjour", [])
    assert content == "Bonjour"


# --- Ordre des modèles Groq avec images ----------------------------------

def test_groq_models_ordonnes_vision_en_tete(monkeypatch):
    from app.core import assistant

    monkeypatch.setenv("GROQ_MODELS", "openai/gpt-oss-20b,qwen/qwen3.6-27b,openai/gpt-oss-120b,qwen/qwen3.8-27b")
    sans_image = assistant._groq_models_ordonnes([])
    assert sans_image == ["openai/gpt-oss-20b", "qwen/qwen3.6-27b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"]

    avec_image = assistant._groq_models_ordonnes([Path("x.png")])
    assert avec_image[0] == "qwen/qwen3.8-27b"
    assert avec_image.count("qwen/qwen3.8-27b") == 1  # pas de doublon


def test_groq_vision_models_defaut_et_env(monkeypatch):
    from app.core import assistant

    monkeypatch.delenv("GROQ_VISION_MODELS", raising=False)
    assert assistant._groq_vision_models() == {"qwen/qwen3.8-27b"}

    monkeypatch.setenv("GROQ_VISION_MODELS", "a/b,c/d")
    assert assistant._groq_vision_models() == {"a/b", "c/d"}


# --- Corps de requête Groq (à travers `_call_groq`) ----------------------

def test_call_groq_corps_textuel_sans_images(monkeypatch):
    from app.core import assistant

    corps = {}

    def handler(request: httpx.Request) -> httpx.Response:
        corps["json"] = json.loads(request.content.decode())
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(assistant, "_get_http_client", lambda: client)
    monkeypatch.setenv("GROQ_API_KEY", "cle-test")
    monkeypatch.setenv("GROQ_MODELS", "openai/gpt-oss-20b")

    resultat = asyncio.run(assistant._call_groq("salut", []))
    assert resultat == "ok"
    assert corps["json"]["messages"][0]["content"] == "salut"


def test_call_groq_corps_vision_avec_images(monkeypatch, tmp_path):
    from app.core import assistant

    p = _png_tmp(tmp_path)
    corps = {}

    def handler(request: httpx.Request) -> httpx.Response:
        corps["json"] = json.loads(request.content.decode())
        return httpx.Response(200, json={"choices": [{"message": {"content": "Rouge"}}]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(assistant, "_get_http_client", lambda: client)
    monkeypatch.setenv("GROQ_API_KEY", "cle-test")
    monkeypatch.setenv("GROQ_MODELS", "qwen/qwen3.8-27b")

    resultat = asyncio.run(assistant._call_groq("Quelle couleur ?", [p]))
    assert resultat == "Rouge"
    content = corps["json"]["messages"][0]["content"]
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "Quelle couleur ?"}
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")


# --- Prodz : plus de mode démonstration ----------------------------------

def test_prod_erreur_au_lieu_de_la_demo(monkeypatch):
    """En production, sans aucun fournisseur, `ask_assistant_stream` LÈVE
    `FournisseursIndisponiblesError` au lieu de céder le message simulé."""
    from app.core import assistant

    monkeypatch.setenv("ENV", "prod")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    with pytest.raises(assistant.FournisseursIndisponiblesError):
        _collecteur(assistant.ask_assistant_stream({"matiere": "Mathématiques"}, "", "2+2 ?", []))


def test_ask_assistant_prod_leve_erreur(monkeypatch):
    from app.core import assistant

    monkeypatch.setenv("ENV", "prod")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    with pytest.raises(assistant.FournisseursIndisponiblesError):
        asyncio.run(assistant.ask_assistant({"matiere": "Mathématiques"}, "", "2+2 ?", []))


def test_dev_conserve_le_mode_demo(monkeypatch):
    """Hors production, le mode démonstration reste le repli habituel."""
    from app.core import assistant

    monkeypatch.setenv("ENV", "dev")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    morceaux = _collecteur(assistant.ask_assistant_stream({"matiere": "Mathématiques"}, "", "2+2 ?", []))
    assert any("Mode démonstration" in c for c in morceaux)


def test_stream_prod_jamais_de_mode_demo(eleve, epreuve_gratuite, monkeypatch):
    """INTEGRATION HTTP : en prod, le flux SSE ne contient JAMAIS le texte
    « Mode démonstration » ; il porte un évènement `error` honnête."""
    monkeypatch.setenv("ENV", "prod")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    r = eleve.post(
        "/api/assistant/ask/stream",
        json={"epreuve_id": epreuve_gratuite, "message": "2+2 ?"},
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")

    events = []
    for line in r.text.splitlines():
        if not line.startswith("data:"):
            continue
        events.append(json.loads(line[len("data:"):].strip()))

    assert any(e["type"] == "chunk" and "Mode démonstration" in e["text"] for e in events) is False
    erreurs = [e for e in events if e["type"] == "error"]
    assert erreurs, events
    assert "indisponibles" in erreurs[0]["message"].lower(), erreurs[0]