"""Quota 429 et message du mode démonstration de l'assistant élève.

Contexte (logs prod) : une question avec images fonctionne, la suivante
retombe en « mode démonstration » — candidat n°1 : le quota des API
gratuites (429). Le quota est GLOBAL au fournisseur, pas au modèle : sans
pause, la liste entière de modèles est brûlée en vain dès le premier 429
transitoire. Correctifs :
  - `_call_provider` / `_stream_provider` ne retentent QU'UNE FOIS (sur le
    même modèle, après 2 s) au premier 429 — plafonné, jamais une boucle.
  - l'absence de clé est loggée (elle était totalement silencieuse).
  - `_demo_fallback` distingue « aucune clé » de « fournisseurs
    indisponibles (quota) »."""
from __future__ import annotations

import asyncio

import httpx2


# --- utils ---------------------------------------------------------------

async def _sans_attente(*_args, **_kwargs):
    return None


def _collecteur(agen) -> list[str]:
    """Itère un générateur asynchrone et renvoie ses fragments."""
    morceaux: list[str] = []

    async def _inner():
        async for c in agen:
            morceaux.append(c)

    asyncio.run(_inner())
    return morceaux


# --- `_demo_fallback` : message distinct selon la présence de clés -------

def test_demo_fallback_distinguie_cle_absente_et_quota():
    from app.core import assistant

    meta = {"matiere": "Mathématiques"}
    sans_cle = assistant._demo_fallback(meta, "2+2 ?", [], cle_ia=False)
    avec_quota = assistant._demo_fallback(meta, "2+2 ?", [], cle_ia=True)

    assert "Mode démonstration" in sans_cle
    assert "aucune clé" in sans_cle
    assert "Mode démonstration" in avec_quota
    assert "quota" in avec_quota
    # Le test intégration (flux SSE) se contente de `"Mode démonstration" in text`.
    assert "simulée" in sans_cle and "simulée" in avec_quota


# --- `_stream_provider` : retry unique sur 429 ---------------------------

def test_stream_provider_retente_une_fois_puis_reussit(monkeypatch):
    """Un 429 transitoire (quota global du fournisseur) déclenche UNE
    nouvelle tentative sur le MÊME modèle plutôt que de basculer sur le
    modèle suivant — le 2e appel (même modèle) réussit, aucun autre modèle
    n'est essayé."""
    from app.core import assistant

    appels = {"n": 0}

    def handler(request: httpx2.Request) -> httpx2.Response:
        appels["n"] += 1
        if appels["n"] == 1:
            return httpx2.Response(429, json={"error": {"code": 429, "status": "RESOURCE_EXHAUSTED"}})
        return httpx2.Response(
            200,
            text='data: {"candidates":[{"content":{"parts":[{"text":"Réponse OK"}]}}]}\n\n',
        )

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    monkeypatch.setattr(assistant, "_get_http_client", lambda: client)
    monkeypatch.setattr(asyncio, "sleep", _sans_attente)
    monkeypatch.setenv("GEMINI_API_KEY", "cle-test")
    monkeypatch.setenv("GEMINI_MODELS", "modele-1,modele-2")

    morceaux = _collecteur(assistant._stream_provider("Gemini", [{"text": "salut"}], "GEMINI_API_KEY"))
    assert morceaux == ["Réponse OK"]
    # 1 échec 429 + 1 nouvelle tentative réussie — le 2e modèle n'est PAS essayé.
    assert appels["n"] == 2


def test_stream_provider_429_persistant_passe_au_modele_suivant(monkeypatch):
    """Quota toujours épuisé : après l'unique retentative, la liste continue
(modèle suivant), aucune pause supplémentaire (le flag `quota_retente`
        est local au fournisseur et plafonne à une tentative)."""
    from app.core import assistant

    appels = {"n": 0}

    def handler(request: httpx2.Request) -> httpx2.Response:
        appels["n"] += 1
        return httpx2.Response(429, json={"error": {"code": 429}})

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    monkeypatch.setattr(assistant, "_get_http_client", lambda: client)
    monkeypatch.setattr(asyncio, "sleep", _sans_attente)
    monkeypatch.setenv("GEMINI_API_KEY", "cle-test")
    monkeypatch.setenv("GEMINI_MODELS", "modele-1,modele-2")

    morceaux = _collecteur(assistant._stream_provider("Gemini", [{"text": "salut"}], "GEMINI_API_KEY"))
    assert morceaux == []
    # modele-1 : essai + retentative ; modele-2 : essai seul.
    assert appels["n"] == 3


# --- `_call_provider` : retry unique sur 429 -----------------------------

def test_call_provider_retente_une_fois_sur_429(monkeypatch):
    from app.core import assistant

    appels = {"n": 0}

    def handler(request: httpx2.Request) -> httpx2.Response:
        appels["n"] += 1
        if appels["n"] == 1:
            return httpx2.Response(429, json={"error": {"code": 429}})
        return httpx2.Response(200, json={"candidates": [{"content": {"parts": [{"text": "ok"}]}}]})

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    monkeypatch.setattr(assistant, "_get_http_client", lambda: client)
    monkeypatch.setattr(asyncio, "sleep", _sans_attente)
    monkeypatch.setenv("GEMINI_API_KEY", "cle-test")
    monkeypatch.setenv("GEMINI_MODELS", "modele-1")

    resultat = asyncio.run(assistant._call_provider("Gemini", [{"text": "salut"}], "GEMINI_API_KEY"))
    assert resultat == "ok"
    assert appels["n"] == 2