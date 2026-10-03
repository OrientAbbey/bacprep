"""Lot 1 — quotas IA journaliers, IP cliente, WebSocket, health."""
from __future__ import annotations

import pytest
from starlette.websockets import WebSocketDisconnect

import app.routers.assistant as assistant_router


def _poser_quotas(monkeypatch, jour=None, global_=None):
    monkeypatch.setenv("ASSISTANT_RATE_LIMIT", "1")
    assistant_router._ask_limiter.reset()
    assistant_router._quota_jour.reset()
    assistant_router._quota_global.reset()
    if jour is not None:
        monkeypatch.setattr(assistant_router._quota_jour, "_max", jour)
    if global_ is not None:
        monkeypatch.setattr(assistant_router._quota_global, "_max", global_)


def _ask(client, epreuve_id):
    return client.post(
        "/api/assistant/ask/stream",
        json={"epreuve_id": epreuve_id, "message": "Bonjour", "contexte": "x", "historique": []},
    )


def test_quota_journalier_par_compte(eleve, epreuve_gratuite, monkeypatch):
    _poser_quotas(monkeypatch, jour=2)
    assert _ask(eleve, epreuve_gratuite).status_code == 200
    assert _ask(eleve, epreuve_gratuite).status_code == 200
    r = _ask(eleve, epreuve_gratuite)
    assert r.status_code == 429 and "Quota quotidien" in r.json()["detail"]
    monkeypatch.setenv("ASSISTANT_RATE_LIMIT", "0")


def test_quota_global_du_site(eleve, epreuve_gratuite, monkeypatch):
    _poser_quotas(monkeypatch, global_=1)
    assert _ask(eleve, epreuve_gratuite).status_code == 200
    r = _ask(eleve, epreuve_gratuite)
    assert r.status_code == 429 and "sollicité" in r.json()["detail"]
    monkeypatch.setenv("ASSISTANT_RATE_LIMIT", "0")


def _requete(headers: dict, client=("10.0.0.9", 1234)):
    from starlette.requests import Request

    scope = {
        "type": "http", "method": "GET", "path": "/",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": client,
    }
    return Request(scope)


def test_client_ip_proxy_configurable(monkeypatch):
    from app.core import rate_limit

    monkeypatch.setattr(rate_limit, "is_prod", lambda: True)
    entetes = {"true-client-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9, 5.6.7.8"}
    assert rate_limit.client_ip(_requete(entetes)) == "1.2.3.4"
    monkeypatch.setenv("TRUST_CLIENT_IP_HEADERS", "0")
    assert rate_limit.client_ip(_requete(entetes)) == "5.6.7.8"  # entrée la plus à droite
    monkeypatch.setenv("TRUSTED_PROXY_HOPS", "2")
    assert rate_limit.client_ip(_requete(entetes)) == "9.9.9.9"


def test_health_verifie_la_base_et_expose_l_ip(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    assert "ip" in client.get("/api/health/ip").json()


def test_websocket_refuse_une_origine_etrangere(client):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws/session", headers={"origin": "https://evil.example"}):
            pass
    assert exc.value.code == 4403


def test_jeton_de_session_urlsafe(eleve):
    jeton = eleve.cookies.get("bacprep_session")
    assert jeton and len(jeton) >= 40
