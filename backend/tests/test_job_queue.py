"""File de jobs persistée, reprise après redémarrage et idempotence.

Ces tests ne passent PAS par un thread de worker (désactivé dans conftest) :
ils appellent les mêmes fonctions que la boucle, de façon déterministe. C'est
la propriété testée — une ligne `pending` reprise, une ligne `running` morte
détectée, jamais deux exécutions — et non la présence d'un thread.
"""
from __future__ import annotations

import json
import zipfile
from datetime import timedelta

import pytest
from sqlalchemy import create_engine, inspect, text

from app.core import job_runner
from app.core.job_queue import MAX_TENTATIVES, nettoyer_temporaires, recouvrer
from app.core.job_runner import reclamer
from app.db import SessionLocal, utc_now
from app.db_models import ImportJobORM, SauvegardeJobORM


@pytest.fixture(autouse=True)
def _schema():
    """Crée le schéma sans démarrer l'application.

    Ces tests n'utilisent pas les fixtures `client`/`admin`, seules à déclencher
    le lifespan qui appelle `create_all`. Sans cette fixture, ils tournent sur
    une base vide quand le fichier est exécuté seul (`no such table`).
    """
    from app.db import Base, engine

    Base.metadata.create_all(bind=engine)
    yield


def _job_export(db, **champs) -> SauvegardeJobORM:
    job = SauvegardeJobORM(
        kind="export",
        status=champs.pop("status", "running"),
        destination=champs.pop("destination", "_sauvegardes/test-reprise"),
        attempts=champs.pop("attempts", 1),
        heartbeat_at=champs.pop("heartbeat_at", utc_now()),
        started_at=champs.pop("started_at", utc_now()),
        **champs,
    )
    db.add(job)
    db.commit()
    return job


def test_running_sans_heartbeat_est_remis_en_attente(db) -> None:
    """Un export interrompu repart : l'écriture d'une destination est idempotente."""
    vieux = utc_now() - timedelta(seconds=job_runner.HEARTBEAT_TIMEOUT_S + 60)
    job = _job_export(db, heartbeat_at=vieux)

    repris = recouvrer(db)

    db.refresh(job)
    assert job.status == "pending"
    assert job.worker_id is None
    assert job.heartbeat_at is None
    assert any("Reprise automatique" in ligne for ligne in json.loads(job.logs_json))
    assert (job.id, "remis en attente") in {(j[1], j[2]) for j in repris}


def test_restauration_interrompue_exige_une_intervention(db) -> None:
    """Une restauration n'est PAS rejouée automatiquement.

    La reprendre à mi-chemin pourrait laisser un catalogue à moitié remplacé ;
    l'écran doit dire « intervention requise » et laisser l'admin relancer un
    essai à blanc.
    """
    vieux = utc_now() - timedelta(seconds=job_runner.HEARTBEAT_TIMEOUT_S + 60)
    job = SauvegardeJobORM(
        kind="restore",
        status="running",
        source="_sauvegardes/test",
        mode="bucket",
        attempts=1,
        started_at=vieux,
        heartbeat_at=vieux,
        params_json=json.dumps({"confirmer": True}),
    )
    db.add(job)
    db.commit()

    recouvrer(db)

    db.refresh(job)
    assert job.status == "error"
    rapport = json.loads(job.report_json)
    assert "Intervention requise" in rapport["erreurs"][0]["erreur"]
    assert job.duration_ms is not None


def test_tentatives_epuisees_marquent_une_erreur(db) -> None:
    vieux = utc_now() - timedelta(seconds=job_runner.HEARTBEAT_TIMEOUT_S + 60)
    job = _job_export(db, heartbeat_at=vieux, attempts=MAX_TENTATIVES)

    recouvrer(db)

    db.refresh(job)
    assert job.status == "error"
    assert "tentative" in json.loads(job.report_json)["erreurs"][0]["erreur"]


def test_reclamation_atomique_une_seule_fois(db) -> None:
    """Deux workers qui voient la même ligne `pending` : un seul gagne."""
    job = SauvegardeJobORM(kind="export", status="pending", destination="_sauvegardes/x")
    db.add(job)
    db.commit()

    autre = SessionLocal()
    try:
        assert reclamer(db, SauvegardeJobORM, job.id, "worker-a") is True
        assert reclamer(autre, SauvegardeJobORM, job.id, "worker-b") is False
        relu = autre.get(SauvegardeJobORM, job.id)
        assert relu.status == "running"
        assert relu.worker_id == "worker-a"
        assert relu.attempts == 1
    finally:
        autre.close()


def test_reprise_import_reextrait_larchive(db, tmp_path, monkeypatch) -> None:
    """Si le dossier extrait a disparu, le worker ré-extrait l'archive source.

    C'est le scénario réel d'un redémarrage Render : le disque du processus
    est neuf, seule la copie conservée permet de reprendre l'import.
    """
    from conftest import purger_catalogue

    purger_catalogue(db)
    archive = tmp_path / "source.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr(
            "2024/terminale/Mathematiques/sujet.md",
            "# Reprise\n\nUn sujet importé après redémarrage.",
        )
    extract_dir = tmp_path / "disparu" / "contenu"

    job = ImportJobORM(
        filename="reprise.zip",
        status="pending",
        params_json=json.dumps(
            {"extract_dir": str(extract_dir), "source_local": str(archive)}
        ),
    )
    db.add(job)
    db.commit()

    assert job_runner.executer("import", job.id) is True

    db.refresh(job)
    assert job.status == "done", job.report_json
    rapport = json.loads(job.report_json)
    assert rapport["epreuves_creees"] >= 1
    assert (extract_dir / "2024/terminale/Mathematiques/sujet.md").is_file()
    # Succès : les sources ne sont plus conservées.
    assert not job_runner.dossier_job_import(job.id).exists()


def test_export_repris_nettoie_la_destination(db) -> None:
    """Une reprise ne laisse pas les parties d'une tentative interrompue."""
    from app.core.storage import get_storage
    from conftest import purger_catalogue

    purger_catalogue(db)
    destination = "_sauvegardes/test-reprise-nettoyage"
    stockage = get_storage()
    stockage.put_bytes(f"{destination}/part-9999.zip", b"reste d'une tentative")
    job = _job_export(
        db,
        status="pending",
        destination=destination,
        attempts=2,
    )

    assert job_runner.executer("export", job.id) is True

    db.refresh(job)
    assert job.status == "done", job.report_json
    restes = [o["cle"] for o in stockage.list_objects(destination + "/")]
    assert f"{destination}/part-9999.zip" not in restes
    assert f"{destination}/_READY" in restes


def test_migration_colonnes_jobs_idempotente(tmp_path, monkeypatch) -> None:
    """La migration ajoute les colonnes à une base existante, deux fois sans erreur."""
    import app.main as main

    moteur = create_engine(f"sqlite:///{tmp_path / 'ancienne.db'}")
    with moteur.begin() as conn:
        conn.execute(text("CREATE TABLE sauvegarde_jobs (id VARCHAR PRIMARY KEY)"))
        conn.execute(text("CREATE TABLE import_jobs (id VARCHAR PRIMARY KEY)"))
    monkeypatch.setattr(main, "engine", moteur)

    main._ensure_job_tracking_columns()
    main._ensure_job_tracking_columns()

    colonnes_sauvegarde = {c["name"] for c in inspect(moteur).get_columns("sauvegarde_jobs")}
    colonnes_import = {c["name"] for c in inspect(moteur).get_columns("import_jobs")}
    attendues = {
        "started_at",
        "heartbeat_at",
        "duration_ms",
        "worker_id",
        "attempts",
        "params_json",
    }
    assert attendues <= colonnes_sauvegarde
    assert attendues <= colonnes_import
    assert {"phase", "phase_started_at"} <= colonnes_sauvegarde


def test_nettoyage_ne_touche_pas_aux_jobs_actifs(db, tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    base = tmp_path / job_runner.TVA_SAUVEGARDES
    (base / "actif").mkdir(parents=True)
    (base / "orphelin").mkdir(parents=True)

    actif = SauvegardeJobORM(kind="export", status="running", destination="_sauvegardes/a")
    db.add(actif)
    db.commit()

    # Le dossier doit porter l'id d'un job actif : on le renomme.
    (base / "actif").rename(base / actif.id)

    supprimes = nettoyer_temporaires(db)

    assert (base / actif.id).is_dir()
    assert not (base / "orphelin").exists()
    assert supprimes >= 1
