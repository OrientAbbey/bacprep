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

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from .jobs.runner import (
    MAX_ZIP_BYTES,
    MAX_ZIP_ENTRIES,
    cle_source_import,
    executer,
    extraire_archive,
)
from ...core.logging_config import get_logger
from ...core.storage import get_storage
from ...db import IMPORTS_DIR, get_db, utc_now
from ...db_models import ImportJobORM
from ...routers.deps import require_admin

router = APIRouter(prefix="/api/admin", tags=["admin-import"])
log = get_logger("admin_import")

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
        "started_at": job.started_at,
        "heartbeat_at": job.heartbeat_at,
        "finished_at": job.finished_at,
        "duration_ms": job.duration_ms,
        "attempts": job.attempts or 0,
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
        # L'extraction valide l'archive et plafonne le nombre d'entrées et
        # d'octets réellement écrits (le `file_size` déclaré est forgeable).
        # Elle est refaite à l'identique par le worker si le dossier extrait a
        # disparu entre-temps : la même fonction est donc partagée.
        extraire_archive(upload_path, extract_dir, MAX_ZIP_ENTRIES, MAX_ZIP_BYTES)
    except ValueError as exc:
        message = str(exc)
        if "trop dense" in message:
            _fail_job(db, job, f"archive trop dense (> {MAX_ZIP_ENTRIES} fichiers)")
            code, detail = 400, f"Archive trop dense (> {MAX_ZIP_ENTRIES} fichiers)"
        elif "invalide" in message:
            _fail_job(db, job, message)
            code, detail = 400, message.capitalize()
        else:
            _fail_job(db, job, "contenu décompressé trop volumineux (200 Mo max)")
            code, detail = 400, "Contenu décompressé trop volumineux (200 Mo max)"
        upload_path.unlink(missing_ok=True)
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(code, detail) from exc
    except Exception as exc:
        _fail_job(db, job, "archive zip invalide ou chiffrée")
        upload_path.unlink(missing_ok=True)
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(400, "Archive zip invalide ou chiffrée") from exc

    # L'archive source est conservée jusqu'à l'état terminal : sans elle, un
    # redémarrage pendant l'import laisserait un job impossible à reprendre
    # (le dossier extrait vit sur le disque non persistant du processus).
    source_local = job_dir / "source.zip"
    shutil.move(str(upload_path), str(source_local))
    cle_source = cle_source_import(job.id)
    try:
        with source_local.open("rb") as src:
            def _blocs():
                while True:
                    bloc = src.read(_CHUNK)
                    if not bloc:
                        break
                    yield bloc

            get_storage().put_stream(
                cle_source, _blocs(), size=source_local.stat().st_size,
                mime_type="application/zip",
            )
    except Exception as exc:
        # La copie objet est la seule garantie de reprise inter-processus ;
        # son échec est signalé mais n'empêche pas l'import en cours.
        log.warning("Archive source de l'import %s non copiée en stockage : %s", job.id, exc)
    job.params_json = json.dumps(
        {
            "extract_dir": str(extract_dir),
            "source_local": str(source_local),
            "source_storage": cle_source,
        },
        ensure_ascii=False,
    )
    db.commit()

    # Pas d'élagage de dossier racine : `_parse_path` identifie chaque
    # segment par sa nature (année, classe, matière) quelle que soit sa
    # position — un dossier racine du type "2022" ne doit jamais être
    # confondu avec un simple préfixe d'archive.
    background.add_task(executer, "import", job.id)
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
