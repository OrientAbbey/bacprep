"""Exécution des travaux longs de l'administration (export, import, restauration).

Ce module est le SEUL endroit qui fait avancer un job. Il est appelé de deux
façons, et c'est ce qui rend le suivi durable :

- par la tâche de fond de la requête HTTP, qui sert de « réveil » immédiat ;
- par la boucle du worker (``job_queue``), qui reprend les jobs ``pending``
  après un redémarrage.

Les deux chemins passent par la même réclamation atomique
(``UPDATE ... WHERE status='pending'``) : un job ne peut donc jamais être
exécuté deux fois, même si les deux tentent en même temps.

Les paramètres nécessaires à une reprise sont persistés dans ``params_json``
(et non seulement gardés en mémoire ou sur le disque temporaire du processus) :
un redémarrage entre le POST et l'exécution ne doit pas rendre le job
irrécupérable.
"""
from __future__ import annotations

import json
import os
import shutil
import zipfile
from functools import partial
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy import func

from ....db import SessionLocal, utc_now
from ....db_models import ImportJobORM, SauvegardeJobORM
from .definitions import WORKER_ID
from ....core.logging_config import get_logger
from ....core.storage import StorageError, get_storage

log = get_logger("job_runner")

TVA_SAUVEGARDES = "sauvegardes_tmp"
PREFIXE_SOURCES_IMPORT = "_imports"

# Un worker qui n'a pas donné signe de vie pendant ce délai est considéré
# comme mort. Généreux à dessein : la compression d'un très gros fichier peut
# durer plusieurs minutes sans rappeler la progression, et requeuter un job
# bien vivant produirait deux exécutions concurrentes.
HEARTBEAT_TIMEOUT_S = int(os.getenv("JOB_HEARTBEAT_TIMEOUT_S", "300"))
MAX_TENTATIVES = max(1, int(os.getenv("JOB_MAX_TENTATIVES", "2")))
RETENTION_TEMP_JOURS = max(1, int(os.getenv("JOB_TEMP_RETENTION_DAYS", "7")))

# Plafonds de l'import massif, partagés par la route d'upload (validation
# immédiate) et par la ré-extraction après redémarrage.
MAX_ZIP_BYTES = 200 * 1024 * 1024  # 200 Mo
MAX_ZIP_ENTRIES = 500  # plafond du nombre de fichiers dans une archive


def _naive(moment: Optional[datetime]) -> Optional[datetime]:
    """Ramène un horodatage en UTC naïf (aware sur PostgreSQL, naïf sur SQLite)."""
    if moment is None:
        return None
    if getattr(moment, "tzinfo", None) is not None:
        return moment.astimezone(timezone.utc).replace(tzinfo=None)
    return moment


def duree_ms(debut, fin) -> Optional[int]:
    """Durée d'exécution en millisecondes, ou None si le job n'a pas commencé."""
    debut, fin = _naive(debut), _naive(fin)
    if debut is None or fin is None:
        return None
    return max(0, int((fin - debut).total_seconds() * 1000))


def noter_journal(logs: list[str], job, db, message: str) -> None:
    """Ajoute une ligne au journal d'un job, rafraîchit son heartbeat et commit."""
    logs.append(message)
    job.logs_json = json.dumps(logs[-200:], ensure_ascii=False)
    job.heartbeat_at = utc_now()
    db.commit()


def dossier_temporaire(job_id: str) -> Path:
    """Dossier de travail d'un job de sauvegarde, sous DATA_DIR (fichiers transitoires supprimés en fin de job)."""
    return Path(os.getenv("DATA_DIR", ".")) / TVA_SAUVEGARDES / job_id


def dossier_job_import(job_id: str) -> Path:
    """Dossier de travail d'un job d'import, sous IMPORTS_DIR/jobs (archive source et fichiers intermédiaires)."""
    from ....db import IMPORTS_DIR

    return IMPORTS_DIR / "jobs" / job_id


def cle_source_import(job_id: str) -> str:
    """Clé de stockage de l'archive ZIP source d'un job d'import (permet de relire le fichier après coup)."""
    return f"{PREFIXE_SOURCES_IMPORT}/{job_id}/source.zip"


def _lire_params(job) -> dict:
    try:
        valeur = json.loads(job.params_json or "{}")
        return valeur if isinstance(valeur, dict) else {}
    except ValueError:
        return {}


def _ecrire_params(job, params: dict) -> None:
    job.params_json = json.dumps(params, ensure_ascii=False)


def reclamer(db, modele, job_id: str, worker_id: str) -> bool:
    """Réclame atomiquement un job ``pending``.

    Le statut est la seule vérité : deux workers qui lisent la même ligne
    ``pending`` ne peuvent pas tous deux réussir cette mise à jour
    conditionnelle. ``started_at`` n'est posé qu'à la PREMIÈRE prise en
    charge : une reprise après redémarrage ne doit pas effacer l'heure de
    départ réelle de l'opération.
    """
    maintenant = utc_now()
    maj = (
        db.query(modele)
        .filter(modele.id == job_id, modele.status == "pending")
        .update(
            {
                modele.status: "running",
                modele.started_at: func.coalesce(modele.started_at, maintenant),
                modele.heartbeat_at: maintenant,
                modele.worker_id: worker_id,
                modele.attempts: func.coalesce(modele.attempts, 0) + 1,
            },
            synchronize_session=False,
        )
    )
    db.commit()
    if not maj:
        log.warning("Job %s déjà pris en charge — abandon", job_id)
        return False
    return True


def _marquer_echec(db, job, message: str) -> None:
    """Passe un job en erreur en conservant la raison, sans écraser un rapport
    plus détaillé déjà écrit par le service."""
    try:
        rapport = json.loads(job.report_json or "{}")
    except ValueError:
        rapport = {}
    if not isinstance(rapport, dict):
        rapport = {}
    rapport.setdefault("erreurs", []).append({"erreur": message})
    job.report_json = json.dumps(rapport, ensure_ascii=False)
    job.status = "error"
    job.finished_at = utc_now()
    job.heartbeat_at = job.finished_at
    job.duration_ms = duree_ms(job.started_at, job.finished_at)
    db.commit()


def _terminer(db, job) -> None:
    job.finished_at = utc_now()
    job.heartbeat_at = job.finished_at
    job.duration_ms = duree_ms(job.started_at, job.finished_at)
    db.commit()


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------


def _executer_export(job_id: str) -> bool:
    from ..export_service import PREFIXE, run_export
    db = SessionLocal()
    logs: list[str] = []
    try:
        if not reclamer(db, SauvegardeJobORM, job_id, WORKER_ID):
            return False
        job = db.query(SauvegardeJobORM).filter(SauvegardeJobORM.id == job_id).one_or_none()
        if not job:
            return False
        maintenant = utc_now()
        job.phase = "manifeste"
        job.phase_started_at = maintenant
        db.commit()

        noter = partial(noter_journal, logs, job, db)

        def progresser(fichiers, total, parties, parties_total, octets) -> None:
            """Met à jour la progression d'un export : fichiers, parties et octets traités."""
            job.fichiers_faits = fichiers
            job.total_fichiers = total
            job.partie_courante = parties
            job.parties_total = parties_total
            job.octets_faits = octets
            job.heartbeat_at = utc_now()
            db.commit()

        def changer_phase(nom: str) -> None:
            """Change la phase affichée du job (« analyse », « écriture », « finalisation »…)."""
            moment = utc_now()
            job.phase = nom
            job.phase_started_at = moment
            job.heartbeat_at = moment
            db.commit()
            log.info("Job d'export %s — phase %s", job_id, nom)

        try:
            # Reprise : la destination appartient à CE job, mais une tentative
            # interrompue peut y avoir laissé un `_READY` partiel ou des
            # parties d'une découpe différente. On repart d'un dossier propre
            # pour que l'état final soit strictement celui du dernier essai.
            if (job.attempts or 1) > 1:
                _vider_destination(job.destination, PREFIXE)
            rapport = run_export(
                db,
                job.destination,
                on_progress=noter,
                dossier_tmp=dossier_temporaire(job_id),
                progression=progresser,
                on_phase=changer_phase,
            )
            job.report_json = json.dumps(rapport, ensure_ascii=False, default=str)
            job.total_octets = rapport.get("octets", 0)
            job.octets_faits = job.total_octets
            job.fichiers_faits = rapport.get("nb_fichiers", 0)
            job.parties_total = len(rapport.get("parties", []))
            job.partie_courante = job.parties_total
            job.status = "done"
        except Exception as exc:
            db.rollback()
            job = db.query(SauvegardeJobORM).filter(SauvegardeJobORM.id == job_id).one()
            _marquer_echec(db, job, str(exc))
            log.exception("Job d'export %s en erreur", job_id)
        if job.status != "error":
            _terminer(db, job)
        log.info(
            "Job d'export %s terminé (%s) en %s ms",
            job_id,
            job.status,
            job.duration_ms,
        )
        return True
    finally:
        db.close()
        shutil.rmtree(dossier_temporaire(job_id), ignore_errors=True)


def _vider_destination(destination: str, prefixe_racine: str) -> None:
    """Supprime les objets d'une destination d'export avant une reprise.

    Garde-fou : la clé doit rester sous le préfixe des sauvegardes. Une
    destination vidée par erreur effacerait une sauvegarde valide.
    """
    if not destination or not destination.startswith(prefixe_racine + "/"):
        raise RuntimeError(f"Destination d'export hors périmètre : {destination!r}")
    stockage = get_storage()
    for objet in stockage.list_objects(destination + "/"):
        stockage.delete(objet["cle"])


# --------------------------------------------------------------------------
# Restauration
# --------------------------------------------------------------------------


def _executer_restauration(job_id: str) -> bool:
    from ..restore_service import ManifesteInvalide, run_restore

    db = SessionLocal()
    logs: list[str] = []
    try:
        if not reclamer(db, SauvegardeJobORM, job_id, WORKER_ID):
            return False
        job = db.query(SauvegardeJobORM).filter(SauvegardeJobORM.id == job_id).one_or_none()
        if not job:
            return False
        params = _lire_params(job)
        confirmer = bool(params.get("confirmer"))
        maintenant = utc_now()
        job.phase = "manifeste"
        job.phase_started_at = maintenant
        db.commit()

        noter = partial(noter_journal, logs, job, db)

        def progresser(fichiers, total, octets, parties, parties_total) -> None:
            """Met à jour la progression d'un import : fichiers, octets et parties traités."""
            job.fichiers_faits = fichiers
            job.total_fichiers = total
            job.octets_faits = octets
            job.partie_courante = parties
            job.parties_total = parties_total
            job.heartbeat_at = utc_now()
            db.commit()

        def changer_phase(nom: str) -> None:
            """Change la phase affichée du job (« analyse », « écriture », « finalisation »…)."""
            moment = utc_now()
            job.phase = nom
            job.phase_started_at = moment
            job.heartbeat_at = moment
            db.commit()
            log.info("Job de restauration %s — phase %s", job_id, nom)

        try:
            rapport = run_restore(
                db,
                job.source,
                mode=job.mode,
                dry_run=not confirmer,
                on_progress=noter,
                dossier_tmp=dossier_temporaire(job_id),
                confirmation_recue=confirmer,
                progression=progresser,
                on_phase=changer_phase,
            )
            job.report_json = json.dumps(rapport, ensure_ascii=False, default=str)
            job.total_fichiers = rapport.get("fichiers", 0)
            job.total_octets = rapport.get("octets", 0)
            if confirmer:
                job.fichiers_faits = rapport.get("ecrits", 0)
                job.octets_faits = job.total_octets
            else:
                # En essai à blanc, rien n'a été écrit : afficher « 400 fichiers
                # faits » ferait croire à une restauration en cours.
                job.fichiers_faits = 0
            job.partie_courante = job.parties_total
            if confirmer and _incomplete(rapport):
                job.status = "error"
            else:
                job.status = "done"
        except ManifesteInvalide as exc:
            db.rollback()
            job = db.query(SauvegardeJobORM).filter(SauvegardeJobORM.id == job_id).one()
            _marquer_echec(db, job, str(exc))
            log.warning("Restauration refusée (%s) : %s", job_id, exc)
        except Exception as exc:
            db.rollback()
            job = db.query(SauvegardeJobORM).filter(SauvegardeJobORM.id == job_id).one()
            _marquer_echec(db, job, str(exc))
            log.exception("Job de restauration %s en erreur", job_id)
        if job.status != "error":
            _terminer(db, job)
        log.info(
            "Job de restauration %s terminé (%s) en %s ms",
            job_id,
            job.status,
            job.duration_ms,
        )
        return True
    finally:
        db.close()
        shutil.rmtree(dossier_temporaire(job_id), ignore_errors=True)


def _incomplete(rapport: dict) -> bool:
    return bool(
        rapport.get("introuvables")
        or rapport.get("incoherences")
        or rapport.get("corrompues")
        or rapport.get("erreurs")
    )


# --------------------------------------------------------------------------
# Import
# --------------------------------------------------------------------------


def extraire_archive(source: Path, destination: Path, max_entrees: int, max_octets: int) -> None:
    """Extrait une archive en refusant les chemins hors destination.

    Utilisée à la fois par la route (validation immédiate) et par la reprise
    d'un import après redémarrage : une archive conservée doit être revalidée,
    pas supposée sûre parce qu'elle a déjà été vue.
    """
    with zipfile.ZipFile(source) as zf:
        count = 0
        for info in zf.infolist():
            if info.is_dir():
                continue
            count += 1
            if count > max_entrees:
                raise ValueError(f"archive trop dense (> {max_entrees} fichiers)")
            cible = (destination / info.filename).resolve()
            try:
                cible.relative_to(destination.resolve())
            except ValueError as exc:
                raise ValueError(f"chemin d'archive invalide: {info.filename}") from exc
        total = 0
        for info in zf.infolist():
            if info.is_dir():
                continue
            cible = (destination / info.filename).resolve()
            cible.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, cible.open("wb") as dst:
                while True:
                    bloc = src.read(1024 * 1024)
                    if not bloc:
                        break
                    total += len(bloc)
                    if total > max_octets:
                        raise ValueError("contenu décompressé trop volumineux")
                    dst.write(bloc)


def _source_import_disponible(job) -> Optional[Path]:
    """Retrouve l'archive source d'un import : disque local, puis stockage.

    Le disque d'un service web n'est PAS persistant en production. La copie
    objet est donc la vraie garantie de reprise ; la copie locale n'évite que
    le téléchargement inutile quand elle est encore là.
    """
    params = _lire_params(job)
    local = params.get("source_local")
    if local and Path(local).is_file():
        return Path(local)
    cle = params.get("source_storage") or cle_source_import(job.id)
    try:
        stockage = get_storage()
        if not stockage.exists(cle):
            return None
        dossier = dossier_job_import(job.id)
        dossier.mkdir(parents=True, exist_ok=True)
        cible = dossier / "source.zip"
        with cible.open("wb") as out:
            for bloc in stockage.open_read(cle):
                out.write(bloc)
        params["source_local"] = str(cible)
        return cible
    except (StorageError, OSError) as exc:
        log.warning("Archive source de l'import %s indisponible : %s", job.id, exc)
        return None


def _executer_import(job_id: str) -> bool:
    from ..import_service import run_import
    db = SessionLocal()
    logs: list[str] = []
    succes = False
    try:
        if not reclamer(db, ImportJobORM, job_id, WORKER_ID):
            return False
        job = db.query(ImportJobORM).filter(ImportJobORM.id == job_id).one_or_none()
        if not job:
            return False
        params = _lire_params(job)
        extract_dir = Path(params.get("extract_dir") or (dossier_job_import(job_id) / "contenu"))

        def persister_log(message: str) -> None:
            """Écrit une ligne dans le journal persisté du job (consultable par l'admin)."""
            logs.append(message)
            job.logs_json = json.dumps(logs, ensure_ascii=False)
            job.heartbeat_at = utc_now()
            db.commit()

        try:
            # Le dossier extrait peut avoir disparu avec le disque du
            # processus : on ré-extrait l'archive conservée. L'import est
            # idempotent sur son contenu (même épreuve + même cible = doublon).
            if not extract_dir.is_dir() or not any(extract_dir.rglob("*")):
                source = _source_import_disponible(job)
                if source is None:
                    raise RuntimeError(
                        "archive source introuvable — relance l'import depuis l'écran"
                    )
                extract_dir.mkdir(parents=True, exist_ok=True)
                extraire_archive(source, extract_dir, MAX_ZIP_ENTRIES, MAX_ZIP_BYTES)
                persister_log("Archive source ré-extraite après redémarrage.")
            rapport = run_import(db, extract_dir, dry_run=False, on_progress=persister_log)
            job.report_json = json.dumps(rapport, ensure_ascii=False)
            job.status = "done"
            succes = True
        except Exception as exc:
            db.rollback()
            job = db.query(ImportJobORM).filter(ImportJobORM.id == job_id).one()
            _marquer_echec(db, job, str(exc))
            log.exception("Job d'import %s en erreur", job_id)
        if not succes:
            log.info("Job d'import %s terminé en échec", job_id)
            return True
        _terminer(db, job)
        log.info(
            "Job d'import %s terminé (%s) en %s ms",
            job_id,
            job.status,
            job.duration_ms,
        )
        return True
    finally:
        db.close()
        # Succès : les sources ne servent plus. Échec : on les conserve le
        # temps de diagnostiquer (nettoyées par la rétention des temporaires).
        if succes:
            shutil.rmtree(dossier_job_import(job_id), ignore_errors=True)
            try:
                get_storage().delete(cle_source_import(job_id))
            except Exception:
                log.warning("Archive source de l'import %s non supprimée", job_id)


# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------


def executer(kind: str, job_id: str) -> bool:
    """Exécute un job s'il est encore réclamable. Retourne True s'il a été pris."""
    if kind == "export":
        return _executer_export(job_id)
    if kind == "restore":
        return _executer_restauration(job_id)
    if kind == "import":
        return _executer_import(job_id)
    raise ValueError(f"Type de job inconnu : {kind!r}")
