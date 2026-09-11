"""Routes admin : import massif via zip (upload + jobs de fond) — découpé
de l'ancien admin.py monolithique.

Fiabilité des jobs (bugs corrigés) :
- tout échec après création du job (zip invalide, zip-slip, taille
  décompressée) marque le job ``error`` AVANT de lever — sinon l'UI admin
  pollait un job ``pending`` à jamais ;
- le job de fond revendique atomiquement le job
  (``UPDATE ... WHERE status='pending'``) : deux imports lancés en
  parallèle ne peuvent plus exécuter deux fois le même job.
"""
from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from ..core.logging_config import get_logger
from ..db import IMPORTS_DIR, get_db, utc_now
from ..db_models import ImportJobORM
from .deps import require_admin

router = APIRouter(prefix="/api/admin", tags=["admin-import"])
log = get_logger("admin_import")

MAX_ZIP_BYTES = 200 * 1024 * 1024  # 200 Mo
MAX_ZIP_ENTRIES = 500  # plafond du nombre de fichiers dans une archive
_CHUNK = 1024 * 1024


def _job_to_dict(job: ImportJobORM) -> dict:
    report = {}
    if job.report_json and job.report_json != "{}":
        try:
            report = json.loads(job.report_json)
        except ValueError:
            report = {}
    try:
        logs = json.loads(job.logs_json or "[]")
    except ValueError:
        logs = []
    return {
        "id": job.id,
        "filename": job.filename,
        "status": job.status,
        "created_at": job.created_at,
        "finished_at": job.finished_at,
        "report": report,
        "logs": logs,
    }


def _fail_job(db: Session, job: ImportJobORM, message: str) -> None:
    """Marque le job en erreur (rapport + horodatage) — à appeler avant
    toute levée d'exception post-création, pour que l'UI cesse de poller."""
    job.status = "error"
    job.report_json = json.dumps(
        {"erreurs": [{"fichier": "", "erreur": message}]}, ensure_ascii=False
    )
    job.finished_at = utc_now()
    db.commit()


def _run_import_job(job_id: str, extract_dir: str) -> None:
    """Tâche de fond : exécute l'import du dossier extrait puis persiste le
    rapport. Utilise SA propre session (une tâche de fond ne peut pas
    réutiliser la session de la requête HTTP qui l'a planifiée). Les lignes
    de journal produites par le moteur sont accumulées dans `logs_json` à
    chaque étape (via une session dédiée) — l'interface admin les affiche
    en direct pendant le traitement grâce au polling existant."""
    from ..core.import_service import run_import
    from ..db import SessionLocal

    logs: list[str] = []

    def persist_log(message: str) -> None:
        logs.append(message)
        session = SessionLocal()
        try:
            job = session.query(ImportJobORM).filter(ImportJobORM.id == job_id).one_or_none()
            if job:
                job.logs_json = json.dumps(logs, ensure_ascii=False)
                session.commit()
        finally:
            session.close()

    db = SessionLocal()
    try:
        # Claim atomique : seul le worker qui réussit cette mise à jour
        # conditionnelle exécute l'import (les doublons d'exécution
        # simultanée créaient des épreuves dupliquées et des verrous SQLite).
        claimed = (
            db.query(ImportJobORM)
            .filter(ImportJobORM.id == job_id, ImportJobORM.status == "pending")
            .update({ImportJobORM.status: "running"})
        )
        db.commit()
        if not claimed:
            log.warning("Job d'import %s déjà pris en charge — abandon", job_id)
            return
        job = db.query(ImportJobORM).filter(ImportJobORM.id == job_id).one_or_none()
        if not job:
            return
        try:
            report = run_import(db, Path(extract_dir), dry_run=False, on_progress=persist_log)
            job.report_json = json.dumps(report, ensure_ascii=False)
            job.status = "done"
        except Exception as exc:
            db.rollback()
            job.report_json = json.dumps({"erreurs": [{"fichier": "", "erreur": str(exc)}]}, ensure_ascii=False)
            job.status = "error"
            log.exception("Job d'import %s en erreur", job_id)
        job.finished_at = utc_now()
        db.commit()
        log.info("Job d'import %s terminé (%s)", job_id, job.status)
    finally:
        db.close()
        # Purge du contenu extrait une fois le traitement fini (succès ou
        # échec) : seuls le zip source et la table jobs restent sur disque.
        shutil.rmtree(Path(extract_dir).parent, ignore_errors=True)


@router.post("/import")
def admin_import_zip(
    background: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Import massif via l'interface admin : reçoit un dossier compressé
    (zip), l'extrait dans la zone d'import et planifie le traitement de
    fond (même moteur que le script CLI `python -m app.scripts.importer`).
    Retourne immédiatement l'id du job — le statut et le rapport détaillé
    (créées/doublons/erreurs/métadonnées manquantes) se lisent via
    GET /api/admin/import/jobs/{id}.

    Route SYNCHRONE (def, threadpool) : extraction zip jusqu'à 200 Mo en
    async gelait toute l'API. L'archive est streamée en chunks vers un
    fichier temporaire avec compteur — jamais 200 Mo d'un coup en RAM."""
    name = file.filename or "import.zip"
    if not name.lower().endswith(".zip"):
        raise HTTPException(400, "Le fichier doit être une archive .zip")

    IMPORTS_DIR.mkdir(parents=True, exist_ok=True)
    upload_path = IMPORTS_DIR / f"upload_{utc_now().strftime('%Y%m%d%H%M%S%f')}.zip"
    received = 0
    try:
        with upload_path.open("wb") as out:
            while True:
                chunk = file.file.read(_CHUNK)
                if not chunk:
                    break
                received += len(chunk)
                if received > MAX_ZIP_BYTES:
                    raise HTTPException(400, "Archive trop volumineuse (200 Mo max)")
                out.write(chunk)
    except HTTPException:
        upload_path.unlink(missing_ok=True)
        raise

    job = ImportJobORM(filename=name, status="pending")
    db.add(job)
    db.commit()

    job_dir = IMPORTS_DIR / "jobs" / job.id
    extract_dir = job_dir / "contenu"
    extract_dir.mkdir(parents=True, exist_ok=True)

    try:
        with zipfile.ZipFile(upload_path) as zf:
            # Extraction sécurisée : rejette d'abord les entrées absolues ou
            # avec '..' (zip slip) et plafonne le nombre de fichiers (un zip
            # de millions de petits fichiers créerait une explosion du nombre
            # d'inodes / du temps d'extraction).
            count = 0
            for info in zf.infolist():
                if info.is_dir():
                    continue
                count += 1
                if count > MAX_ZIP_ENTRIES:
                    _fail_job(db, job, f"archive trop dense (> {MAX_ZIP_ENTRIES} fichiers)")
                    raise HTTPException(400, f"Archive trop dense (> {MAX_ZIP_ENTRIES} fichiers)")
                try:
                    target = (extract_dir / info.filename).resolve()
                    target.relative_to(extract_dir.resolve())
                except ValueError:
                    _fail_job(db, job, f"chemin d'archive invalide: {info.filename}")
                    raise HTTPException(400, f"Chemin d'archive invalide: {info.filename}")
            # Extraction membre par membre avec compteur d'octets RÉELS écrits
            # sur disque : le champ `info.file_size` est déclaré dans
            # l'archive et forgeable (zip-bomb), seule la taille réellement
            # écrite au fil de l'eau fait foi. Un zip chiffré ou corrompu
            # lève ici RuntimeError/OSError -> 400 générique, job en erreur.
            total = 0
            for info in zf.infolist():
                if info.is_dir():
                    continue
                target = (extract_dir / info.filename).resolve()
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, target.open("wb") as dst:
                    while True:
                        chunk = src.read(_CHUNK)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MAX_ZIP_BYTES:
                            _fail_job(db, job, "contenu décompressé trop volumineux (200 Mo max)")
                            raise HTTPException(400, "Contenu décompressé trop volumineux (200 Mo max)")
                        dst.write(chunk)
    except HTTPException:
        upload_path.unlink(missing_ok=True)
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except Exception as exc:
        _fail_job(db, job, "archive zip invalide ou chiffrée")
        upload_path.unlink(missing_ok=True)
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(400, "Archive zip invalide ou chiffrée") from exc

    upload_path.unlink(missing_ok=True)

    # Pas d'élagage de dossier racine : `_parse_path` identifie chaque
    # segment par sa nature (année, classe, matière) quelle que soit sa
    # position — un dossier racine du type "2022" ne doit jamais être
    # confondu avec un simple préfixe d'archive.
    background.add_task(_run_import_job, job.id, str(extract_dir))
    log.info("Job d'import %s planifié (%s, %d o)", job.id, name, received)
    return {"job_id": job.id, "status": "pending"}


@router.get("/import/jobs")
def admin_list_import_jobs(db: Session = Depends(get_db), lock=Depends(require_admin)) -> list[dict]:
    """Tous les jobs d'import massif, les plus récents d'abord."""
    jobs = db.query(ImportJobORM).order_by(ImportJobORM.created_at.desc()).limit(50).all()
    return [_job_to_dict(j) for j in jobs]


@router.get("/import/jobs/{job_id}")
def admin_get_import_job(job_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    """Statut + rapport détaillé d'un job d'import massif."""
    job = db.query(ImportJobORM).filter(ImportJobORM.id == job_id).one_or_none()
    if not job:
        raise HTTPException(404, "Job introuvable")
    return _job_to_dict(job)
