"""Sauvegarde planifiée (jeton) et journaux JSON."""
from __future__ import annotations

import json
import logging

import pytest

TOKEN = "jeton-de-test-0123456789-abcdef"


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    from app.routers import cron

    cron._limiteur.reset()
    monkeypatch.setenv("LOGIN_RATE_LIMIT", "1")
    yield
    cron._limiteur.reset()
    monkeypatch.setenv("LOGIN_RATE_LIMIT", "0")


def test_cron_ferme_sans_configuration(client, monkeypatch):
    monkeypatch.delenv("CRON_TOKEN", raising=False)
    assert client.post("/api/cron/backup", headers={"X-Cron-Token": TOKEN}).status_code == 503
    monkeypatch.setenv("CRON_TOKEN", "court")
    assert client.post("/api/cron/backup", headers={"X-Cron-Token": "court"}).status_code == 503


def test_cron_refuse_un_mauvais_jeton(client, monkeypatch):
    monkeypatch.setenv("CRON_TOKEN", TOKEN)
    assert client.post("/api/cron/backup").status_code == 401
    assert client.post("/api/cron/backup", headers={"X-Cron-Token": TOKEN + "x"}).status_code == 401


def test_cron_lance_un_export_trace_et_limite(client, monkeypatch, db):
    from app.db_models import AdminEventORM, SauvegardeJobORM

    monkeypatch.setenv("CRON_TOKEN", TOKEN)
    r = client.post("/api/cron/backup", headers={"X-Cron-Token": TOKEN})
    assert r.status_code == 200, r.text
    job = db.get(SauvegardeJobORM, r.json()["job_id"])
    assert job is not None and job.kind == "export"
    ev = db.query(AdminEventORM).filter(AdminEventORM.action == "sauvegarde_export_demande", AdminEventORM.email == "cron").first()
    assert ev is not None
    for _ in range(2):
        client.post("/api/cron/backup", headers={"X-Cron-Token": TOKEN})
    assert client.post("/api/cron/backup", headers={"X-Cron-Token": TOKEN}).status_code == 429


def test_formateur_json_une_ligne_valide_avec_champs_extra():
    from app.core.logging_config import JsonFormatter

    rec = logging.LogRecord("bacprep.requete", logging.INFO, __file__, 1, "requête", None, None)
    rec.methode, rec.statut, rec.duree_ms = "GET", 200, 12
    d = json.loads(JsonFormatter().format(rec))
    assert d["niveau"] == "INFO" and d["message"] == "requête" and d["statut"] == 200 and d["duree_ms"] == 12
    assert "ts" in d and "\n" not in JsonFormatter().format(rec)


def test_formateur_json_exception():
    from app.core.logging_config import JsonFormatter

    try:
        raise ValueError("boom")
    except ValueError:
        import sys

        rec = logging.LogRecord("x", logging.ERROR, __file__, 1, "échec", None, sys.exc_info())
    assert "ValueError: boom" in json.loads(JsonFormatter().format(rec))["exception"]


def test_journal_requete_json_sans_donnees_personnelles(client, monkeypatch, caplog):
    monkeypatch.setenv("LOG_FORMAT", "json")
    with caplog.at_level(logging.INFO, logger="bacprep.requete"):
        r = client.get("/api/pricing?secret=abc", headers={"X-Forwarded-For": "1.2.3.4"})
    assert r.headers.get("X-Request-ID")
    recs = [x for x in caplog.records if x.name == "bacprep.requete"]
    assert recs and recs[-1].chemin == "/api/pricing" and recs[-1].statut == 200
    texte = json.dumps({k: str(v) for k, v in recs[-1].__dict__.items()})
    assert "abc" not in texte and "1.2.3.4" not in texte  # ni requête, ni IP
    monkeypatch.delenv("LOG_FORMAT")
    assert "X-Request-ID" not in client.get("/api/pricing").headers  # mode texte : inchangé


def test_sonde_de_vivacite_sans_base(client, monkeypatch):
    """/api/health/live (healthCheckPath Render) ne touche pas la base."""
    import app.main as m

    monkeypatch.setattr(m, "SessionLocal", lambda: (_ for _ in ()).throw(RuntimeError("base injoignable")))
    assert client.get("/api/health/live").json() == {"status": "ok"}
    with pytest.raises(RuntimeError):  # /api/health, lui, interroge la base
        client.get("/api/health")
