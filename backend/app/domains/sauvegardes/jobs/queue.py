"""File de jobs persistée en base et worker durable.

Pourquoi un worker, alors que les routes utilisaient déjà ``BackgroundTasks`` :
une tâche de fond vit DANS le processus HTTP. Un déploiement, un redémarrage
ou un crash la fait disparaître — la ligne de job reste ``pending``, aucun
processus ne la réclamera, et l'écran interroge indéfiniment une opération qui
n'existe plus. La file en base est la source de vérité ; le worker n'est qu'un
consommateur remplaçable.

Deux modes de lancement :

- **en processus** (défaut) : un thread démarre avec l'application. Suffisant
  pour un service unique (Render) et pour le développement ;
- **séparé** : ``JOB_WORKER_ENABLED=0`` sur le service web, puis
  ``python -m app.worker`` sur un processus dédié. La file étant en base, les
  deux modes sont interchangeables.

Le worker ne réclame jamais un job déjà ``running`` : la réclamation atomique
de ``job_runner.reclamer`` garantit qu'un seul exécutant gagne. Il ne « devine »
pas non plus qu'un job est mort sur la seule foi de son âge : c'est le
heartbeat qui fait foi.
"""
from __future__ import annotations

import json
import os
import shutil
import threading
from datetime import timedelta
from pathlib import Path

from ....db import SessionLocal, utc_now
from ....db_models import ImportJobORM, SauvegardeJobORM
from .runner import (
    HEARTBEAT_TIMEOUT_S,
    MAX_TENTATIVES,
    RETENTION_TEMP_JOURS,
    TVA_SAUVEGARDES,
    _marquer_echec,
    _naive,
    dossier_job_import,
    executer,
)
from .definitions import POLL_S, WORKER_ID
from ....core.logging_config import get_logger

log = get_logger("job_queue")

_MODELES = (
    (SauvegardeJobORM, "export"),
    (SauvegardeJobORM, "restore"),
    (ImportJobORM, "import"),
)


def reclamer_suivant(db) -> tuple[str, str] | None:
    """Tente d'exécuter le plus ancien job en attente, tous types confondus.

    Retourne ``(kind, job_id)`` si un job a été pris en charge, sinon ``None``.
    Le choix et la réclamation sont deux étapes distinctes : deux workers
    peuvent choisir la même ligne, mais un seul réussira la mise à jour
    conditionnelle de ``job_runner.reclamer``.
    """
    candidats: list[tuple[str, str, object]] = []
    for modele, kind in _MODELES:
        requete = db.query(modele).filter(modele.status == "pending")
        if modele is SauvegardeJobORM:
            requete = requete.filter(modele.kind == kind)
        job = requete.order_by(modele.created_at.asc()).first()
        if job is not None:
            candidats.append((kind, job.id, job.created_at))
    candidats.sort(key=lambda c: (_naive(c[2]) or _naive(utc_now())))
    for kind, job_id, _ in candidats:
        if executer(kind, job_id):
            return kind, job_id
    return None


def recouvrer(db) -> list[tuple[str, str, str]]:
    """Traite les jobs ``running`` dont le heartbeat a expiré.

    Politique par type :

    - export et import sont IDEMPOTENTS (réécriture d'une destination propre,
      doublon logique détecté) : on les remet en attente tant que le nombre de
      tentatives le permet ;
    - une restauration en écriture ne l'est pas : la reprendre à mi-chemin
      pourrait laisser un catalogue à moitié remplacé. Elle passe en erreur
      avec la mention « intervention requise », et l'administrateur relance
      un essai à blanc.
    """
    maintenant = utc_now()
    repris: list[tuple[str, str, str]] = []
    for modele, kind in _MODELES:
        requete = db.query(modele).filter(modele.status == "running")
        if modele is SauvegardeJobORM:
            requete = requete.filter(modele.kind == kind)
        for job in requete.all():
            dernier = job.heartbeat_at or job.started_at or job.created_at
            if dernier is None:
                continue
            age = (maintenant - dernier).total_seconds()
            if age < HEARTBEAT_TIMEOUT_S:
                continue
            if kind == "restore":
                _marquer_echec(
                    db,
                    job,
                    "Intervention requise : la restauration a été interrompue "
                    f"(aucune activité depuis {int(age)} s). Relance un essai "
                    "à blanc, puis l'écriture si le rapport est propre.",
                )
                repris.append((kind, job.id, "intervention requise"))
            elif (job.attempts or 0) >= MAX_TENTATIVES:
                _marquer_echec(
                    db,
                    job,
                    f"Job interrompu après {job.attempts} tentative(s) "
                    f"(aucune activité depuis {int(age)} s). Relance l'opération.",
                )
                repris.append((kind, job.id, "tentatives épuisées"))
            else:
                job.status = "pending"
                job.worker_id = None
                job.heartbeat_at = None
                try:
                    logs = job.logs_json and json.loads(job.logs_json)
                except ValueError:
                    logs = []
                if not isinstance(logs, list):
                    logs = []
                logs.append(
                    f"Reprise automatique : le worker précédent n'a plus donné "
                    f"de signe de vie depuis {int(age)} s."
                )
                job.logs_json = json.dumps(logs[-200:], ensure_ascii=False)
                repris.append((kind, job.id, "remis en attente"))
            log.warning("Job %s (%s) : %s", job.id, kind, repris[-1][2])
    db.commit()
    return repris


def nettoyer_temporaires(db) -> int:
    """Supprime les dossiers de travail dont plus aucun job actif ne dépend.

    Sans ce nettoyage, chaque redémarrage laisse derrière lui les parties ZIP
    d'un export interrompu et les archives extraites d'un import : le disque se
    remplit lentement, et la panne arrive des mois plus tard, sans lien visible
    avec l'opération qui l'a causée.
    """
    supprimes = 0
    actifs_sauvegardes = {
        j.id
        for j in db.query(SauvegardeJobORM)
        .filter(SauvegardeJobORM.status.in_(("pending", "running")))
        .all()
    }
    actifs_imports = {
        j.id
        for j in db.query(ImportJobORM)
        .filter(ImportJobORM.status.in_(("pending", "running")))
        .all()
    }

    base = Path(os.getenv("DATA_DIR", ".")) / TVA_SAUVEGARDES
    if base.is_dir():
        for dossier in base.iterdir():
            if dossier.is_dir() and dossier.name not in actifs_sauvegardes:
                shutil.rmtree(dossier, ignore_errors=True)
                supprimes += 1

    seuil = utc_now() - timedelta(days=RETENTION_TEMP_JOURS)
    jobs_import = dossier_job_import("x").parent
    if jobs_import.is_dir():
        for dossier in jobs_import.iterdir():
            if not dossier.is_dir() or dossier.name in actifs_imports:
                continue
            modifie = dossier.stat().st_mtime
            if modifie < seuil.timestamp():
                shutil.rmtree(dossier, ignore_errors=True)
                supprimes += 1
    return supprimes


_ARRET: threading.Event | None = None


def boucle_worker(arret: threading.Event) -> None:
    """Boucle de consommation, partagée par le thread intégré et le processus
    autonome (`python -m app.worker`).

    Elle fait trois choses, dans cet ordre : récupérer les jobs dont le worker
    précédent est mort, nettoyer les dossiers temporaires orphelins, puis
    tenter de prendre un job. Le nettoyage n'est pas refait à chaque tour :
    il coûte des parcours de disque et rien ne justifie de le faire toutes les
    deux secondes.
    """
    log.info("Worker de jobs démarré — id=%s", WORKER_ID)
    db = SessionLocal()
    try:
        recouvrer(db)
        nettoyer_temporaires(db)
    except Exception:
        log.exception("Recouvrement initial des jobs impossible")
    finally:
        db.close()

    dernier_nettoyage = utc_now()
    while not arret.is_set():
        pris = False
        db = SessionLocal()
        try:
            recouvrer(db)
            if (utc_now() - dernier_nettoyage).total_seconds() >= 3600:
                nettoyer_temporaires(db)
                dernier_nettoyage = utc_now()
            pris = reclamer_suivant(db) is not None
        except Exception:
            log.exception("Boucle de worker : erreur inattendue")
        finally:
            db.close()
        if not pris:
            arret.wait(POLL_S)
    log.info("Worker de jobs arrêté")


def demarrer_worker() -> threading.Thread | None:
    """Démarre la boucle de worker en processus, si elle est activée."""
    global _ARRET
    if os.getenv("JOB_WORKER_ENABLED", "1").strip() == "0":
        log.info("Worker de jobs désactivé (JOB_WORKER_ENABLED=0)")
        return None
    _ARRET = threading.Event()
    thread = threading.Thread(
        target=boucle_worker, args=(_ARRET,), name="jobs-worker", daemon=True
    )
    thread.start()
    return thread


def arreter_worker(thread: threading.Thread | None) -> None:
    """Réveille la boucle et attend la fin de son cycle en cours."""
    if thread is None:
        return
    if _ARRET is not None:
        _ARRET.set()
    thread.join(timeout=5.0)
