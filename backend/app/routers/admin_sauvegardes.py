"""Routes admin : sauvegardes du catalogue (export et restauration).

L'onglet admin « Sauvegardes » passe par ici.

Deux principes qui structurent les choix de ce fichier :

- **une restauration ne s'écrit jamais par surprise**. Le mode par défaut est
  l'essai à blanc (``dry_run``), et une écriture exige un second appel
  portant ``confirme=true``. Une demande d'écriture sans confirmation est
  rejetée par le service, pas seulement ignorée ;
- **l'admin ne choisit pas où l'on écrit**. La clé de destination est tirée
  de l'horloge serveur. Accepter une clé venue du client permettrait d'écraser
  une autre sauvegarde, ou d'écrire ailleurs que dans le préfixe réservé.

Les travaux longs (export comme restauration) tournent en tâche de fond avec
un job en base, comme l'import : une restauration de plusieurs Go bloquerait
sinon la requête HTTP, et le serveur web derrière un proxy la tuerait.
"""
from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import RedirectResponse, StreamingResponse
from sqlalchemy.orm import Session

from ..core.export_service import (
    NOM_INDEX,
    NOM_MANIFESTE,
    PREFIXE,
    run_export,
)
from ..core.logging_config import get_logger
from ..core.restore_service import (
    MODES,
    MODE_DISASTER,
    ManifesteInvalide,
    run_restore,
)
from ..core.storage import StorageError, get_storage, presigned_url_or_none
from ..db import SessionLocal, get_db, utc_now
from ..db_models import SauvegardeJobORM
from ..models import (
    SauvegardeExportDemande,
    SauvegardeRestaurerDemande,
    SauvegardeResume,
)
from .deps import log_admin_event, require_admin

router = APIRouter(prefix="/api/admin", tags=["admin-sauvegardes"])
log = get_logger("admin_sauvegardes")

_TVA = "sauvegardes_tmp"


def _dossier_tva(job_id: str) -> Path:
    return Path(os.getenv("DATA_DIR", ".")) / _TVA / job_id


def _job_to_dict(job: SauvegardeJobORM) -> dict:
    def charge(brut, defaut):
        try:
            return json.loads(brut) if brut else defaut
        except ValueError:
            return defaut

    return {
        "id": job.id,
        "kind": job.kind,
        "status": job.status,
        "destination": job.destination,
        "source": job.source,
        "mode": job.mode,
        "total_fichiers": job.total_fichiers or 0,
        "fichiers_faits": job.fichiers_faits or 0,
        "total_octets": job.total_octets or 0,
        "octets_faits": job.octets_faits or 0,
        "partie_courante": job.partie_courante or 0,
        "parties_total": job.parties_total or 0,
        "report": charge(job.report_json, {}),
        "logs": charge(job.logs_json, []),
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


# --------------------------------------------------------------------------
# Inventaire des sauvegardes existantes
# --------------------------------------------------------------------------


def _iso(valeur) -> Optional[str]:
    if valeur is None:
        return None
    return valeur.isoformat() if hasattr(valeur, "isoformat") else str(valeur)


def _resume(prefixe: str, stockage) -> Optional[SauvegardeResume]:
    """Construit le récapitulatif d'une sauvegarde depuis son index.

    L'index est la source de vérité : il donne le nombre de parties, leurs
    tailles et leurs empreintes. Le manifeste donne les compteurs métier. Une
    sauvegarde dont l'index est illisible est IGNORÉE plutôt que listée comme
    valide — afficher une sauvegarde qu'on ne peut pas restaurer serait pire
    que de ne pas l'afficher.
    """
    try:
        index = json.loads(stockage.get_bytes(f"{prefixe}/{NOM_INDEX}").decode("utf-8"))
        manifest = json.loads(
            stockage.get_bytes(f"{prefixe}/{NOM_MANIFESTE}").decode("utf-8")
        )
    except (StorageError, ValueError, KeyError):
        log.warning("Sauvegarde ignorée (index ou manifeste illisible) : %s", prefixe)
        return None
    parties = index.get("parties") or []
    return SauvegardeResume(
        cle=prefixe,
        nom=prefixe.rsplit("/", 1)[-1],
        taille_octets=0,
        modifie_le=None,
        parties=[
            {
                "nom": p.get("nom"),
                "octets": int(p.get("octets") or 0),
                "sha256": p.get("sha256"),
                "nb_fichiers": int(p.get("nb_fichiers") or 0),
            }
            for p in parties
        ],
        epreuves=int(manifest.get("epreuve_count") or 0),
        fichiers=int(manifest.get("fichier_count") or 0),
    )


def _lister_sauvegardes() -> list[dict]:
    stockage = get_storage()
    try:
        objets = stockage.list_objects(PREFIXE)
    except NotImplementedError:
        log.warning("Le backend de stockage ne sait pas énumérer les clés")
        return []
    # Regroupement par dossier de sauvegarde : les clés sont
    # `_sauvegardes/<horodatage>/<pièce>`.
    groupes: dict[str, list[dict]] = {}
    for objet in objets:
        cle = objet["cle"]
        reste = cle[len(PREFIXE):].lstrip("/") if cle.startswith(PREFIXE) else ""
        dossier = reste.split("/", 1)[0]
        if not dossier:
            continue
        groupes.setdefault(f"{PREFIXE}/{dossier}", []).append(objet)

    resumes: list[dict] = []
    # Antichronologique : la sauvegarde la plus récente en premier.
    for prefixe in sorted(groupes, reverse=True):
        resume = _resume(prefixe, stockage)
        if resume is None:
            continue
        # Volume RÉELLEMENT occupé (parties + index + manifeste) et date de
        # dernière écriture : c'est ce que l'écran annonce à l'administrateur.
        resume.taille_octets = sum(o.get("taille", 0) for o in groupes[prefixe])
        dates = [o["modifie"] for o in groupes[prefixe] if o.get("modifie")]
        if dates:
            # `modifie` est un `datetime` des deux côtés (le contrat de
            # `list_objects` le garantit), donc le maximum est direct.
            resume.modifie_le = _iso(max(dates))
        resumes.append(resume.model_dump())
    return resumes


@router.get("/sauvegardes")
def lister(client=Depends(require_admin)) -> dict:
    """Inventaire des sauvegardes : la liste, plus le volume total occupé.

    Le volume est affiché sans aucune purge automatique : la suppression reste
    une décision de l'administrateur. Une politique de rétention décidée par
    le système finit toujours par effacer la bonne sauvegarde au mauvais moment.
    """
    sauvegardes = _lister_sauvegardes()
    return {
        "sauvegardes": sauvegardes,
        "total_octets": sum(s["taille_octets"] for s in sauvegardes),
    }


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

# Délai au-delà duquel un job encore `pending` n'est plus « en attente » : il
# n'a jamais été pris en charge. La seule cause connue est un redémarrage du
# service (déploiement) entre la réponse au POST et l'exécution de la tâche de
# fond : la ligne est en base, la tâche, non.
_ATTENTE_MAX = 300  # secondes


def _marquer_orphelin_si_besoin(db, job: SauvegardeJobORM) -> None:
    """Transforme en `error` un job `pending` que plus rien ne réclamera.

    Sans cela, l'écran interroge le job toutes les 1,5 s INDÉFINIMENT : un
    job jamais démarré n'atteindra jamais un état terminal, donc rien n'arrête
    la boucle. Le pire n'est pas le scintillement — c'est un job affiché comme
    « en cours » alors qu'aucun processus ne travaille, avec une barre de
    progression figée à 0 % et rien qui ne le dise.

    On ne touche qu'aux jobs `pending`, jamais aux `running` : un export
    légitimement long (gigaoctets lus depuis S3) doit avoir le droit de finir.
    Juger qu'il est bloqué, c'est l'affaire de l'écran, pas d'une lecture de
    ligne.

    AUCUNE nouvelle colonne : `sauvegardes_jobs` existe déjà en production et
    `Base.metadata.create_all` ne rajoute pas de colonne à une table
    existante — un `heartbeat_at` ajouté ici casserait toute lecture du job
    par `UndefinedColumn` sur le serveur déjà déployé. `created_at` suffit.
    """
    if job.status != "pending" or not job.created_at:
        return
    # Les DEUX côtés sont ramenés en UTC naïf avant la soustraction : mixer un
    # `datetime` aware et un naïf lève `TypeError`. Ce chemin est celui du
    # polling, donc l'exception ne resterait pas invisible — chaque lecture
    # d'un job en attente renverrait une erreur 500 au lieu de son état.
    age = (_naive(utc_now()) - _naive(job.created_at)).total_seconds()
    if age < _ATTENTE_MAX:
        return
    job.status = "error"
    job.finished_at = utc_now()
    job.report_json = json.dumps(
        {
            "erreurs": [
                {
                    "erreur": (
                        f"Job jamais démarré (en attente depuis "
                        f"{int(age)} s). Le service a probablement redémarré "
                        "après le lancement. Relance l'opération."
                    )
                }
            ]
        },
        ensure_ascii=False,
    )
    db.commit()
    log.warning("Job de sauvegarde %s orphelin marqué en erreur", job.id)


def _naive(moment) -> "datetime":
    """`created_at` selon le moteur : aware sur PostgreSQL, naive sur SQLite.

    La comparaison doit se faire dans le même univers que la valeur lue, sinon
    `utc_now() - created_at` lève `TypeError` — précisément sur PostgreSQL,
    c'est-à-dire en production, et seulement là.
    """
    if getattr(moment, "tzinfo", None) is not None:
        return moment.astimezone(timezone.utc).replace(tzinfo=None)
    return moment


def _run_export_job(job_id: str, destination: str) -> None:
    """Tâche de fond : exporte, puis persiste rapport et compteurs.

    Session PROPRE à la tâche de fond (celle de la requête HTTP est fermée
    avant exécution) et réclamation atomique du job, comme l'import : deux
    exports lancés ensemble ne peuvent pas s'exécuter deux fois.
    """
    from ..db import SessionLocal

    db = SessionLocal()
    logs: list[str] = []
    try:
        if not (
            db.query(SauvegardeJobORM)
            .filter(SauvegardeJobORM.id == job_id, SauvegardeJobORM.status == "pending")
            .update({SauvegardeJobORM.status: "running"})
        ):
            db.commit()
            log.warning("Job d'export %s déjà pris en charge — abandon", job_id)
            return
        job = db.query(SauvegardeJobORM).filter(SauvegardeJobORM.id == job_id).one_or_none()
        if not job:
            return

        def noter(message: str) -> None:
            logs.append(message)
            job.logs_json = json.dumps(logs[-200:], ensure_ascii=False)
            db.commit()

        def progresser(fichiers, total, parties, parties_total, octets) -> None:
            job.fichiers_faits = fichiers
            job.total_fichiers = total
            job.partie_courante = parties
            job.parties_total = parties_total
            job.octets_faits = octets
            db.commit()

        try:
            report = run_export(
                db,
                destination,
                on_progress=noter,
                dossier_tmp=_dossier_tva(job_id),
                progression=progresser,
            )
            job.report_json = json.dumps(report, ensure_ascii=False, default=str)
            job.total_octets = report.get("octets", 0)
            job.octets_faits = job.total_octets
            job.fichiers_faits = report.get("nb_fichiers", 0)
            job.parties_total = len(report.get("parties", []))
            job.partie_courante = job.parties_total
            job.status = "done"
        except Exception as exc:
            db.rollback()
            job = db.query(SauvegardeJobORM).filter(SauvegardeJobORM.id == job_id).one()
            job.status = "error"
            job.report_json = json.dumps(
                {"erreurs": [{"erreur": str(exc)}]}, ensure_ascii=False
            )
            log.exception("Job d'export %s en erreur", job_id)
        job.finished_at = utc_now()
        db.commit()
        log.info("Job d'export %s terminé (%s)", job_id, job.status)
    finally:
        db.close()
        shutil.rmtree(_dossier_tva(job_id), ignore_errors=True)


@router.post("/sauvegardes/export")
def lancer_export(
    background: BackgroundTasks,
    demande: SauvegardeExportDemande = SauvegardeExportDemande(),
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Démarre un export et renvoie l'id du job. La destination est calculée
    côté serveur : le client ne choisit pas la clé."""
    job = SauvegardeJobORM(kind="export", status="pending")
    db.add(job)
    db.commit()
    # Horodatage lisible, suffixé par le job : deux exports lancés dans la
    # MÊME seconde ne doivent pas s'écraser l'un l'autre. Une seconde de
    # précision suffit pour un nom, pas pour garantir l'unicité.
    job.destination = f"{PREFIXE}/{utc_now().strftime('%Y-%m-%dT%H%M%SZ')}-{job.id[:6]}"
    db.commit()
    background.add_task(_run_export_job, job.id, job.destination)
    log.info("Export demandé par un administrateur → %s", job.destination)
    # Tracé d'audit : un export est un DUMP du catalogue. Demander « qui a
    # produit cette copie de toutes les données » doit avoir une réponse, et
    # la réponse doit exister avant même que l'export ne se termine.
    log_admin_event(
        db,
        None,
        "sauvegarde_export_demande",
        getattr(lock, "email", "") or "",
        {"job_id": job.id, "destination": job.destination},
    )
    return _job_to_dict(job)


# --------------------------------------------------------------------------
# Restauration
# --------------------------------------------------------------------------


def _run_restore_job(job_id: str, source: str, mode: str, confirmer: bool) -> None:
    from ..db import SessionLocal

    db = SessionLocal()
    logs: list[str] = []
    try:
        if not (
            db.query(SauvegardeJobORM)
            .filter(SauvegardeJobORM.id == job_id, SauvegardeJobORM.status == "pending")
            .update({SauvegardeJobORM.status: "running"})
        ):
            db.commit()
            return
        job = db.query(SauvegardeJobORM).filter(SauvegardeJobORM.id == job_id).one_or_none()
        if not job:
            return

        def noter(message: str) -> None:
            logs.append(message)
            job.logs_json = json.dumps(logs[-200:], ensure_ascii=False)
            db.commit()

        def progresser(fichiers, total, octets, parties, parties_total) -> None:
            job.fichiers_faits = fichiers
            job.total_fichiers = total
            job.octets_faits = octets
            job.partie_courante = parties
            job.parties_total = parties_total
            db.commit()

        try:
            report = run_restore(
                db,
                source,
                mode=mode,
                dry_run=not confirmer,
                on_progress=noter,
                dossier_tmp=_dossier_tva(job_id),
                confirmation_recue=confirmer,
                progression=progresser,
            )
            job.report_json = json.dumps(report, ensure_ascii=False, default=str)
            job.total_fichiers = report.get("fichiers", 0)
            job.total_octets = report.get("octets", 0)
            if confirmer:
                job.fichiers_faits = report.get("ecrits", 0)
                job.octets_faits = job.total_octets
            else:
                # En essai à blanc, `fichiers_faits` reste à 0 : rien n'a été
                # écrit, et afficher « 400 fichiers faits » ferait croire à une
                # restauration en cours.
                job.fichiers_faits = 0
            job.partie_courante = job.parties_total
            # Une restauration incomplète est un ÉCHEC : les métadonnées n'ont
            # pas été écrites, et l'écran doit le dire sans ambiguïté.
            if confirmer and _incomplete(report):
                job.status = "error"
            else:
                job.status = "done"
        except ManifesteInvalide as exc:
            db.rollback()
            job = db.query(SauvegardeJobORM).filter(SauvegardeJobORM.id == job_id).one()
            job.status = "error"
            job.report_json = json.dumps(
                {"erreurs": [{"erreur": str(exc)}]}, ensure_ascii=False
            )
            log.warning("Restauration refusée (%s) : %s", job_id, exc)
        except Exception as exc:
            db.rollback()
            job = db.query(SauvegardeJobORM).filter(SauvegardeJobORM.id == job_id).one()
            job.status = "error"
            job.report_json = json.dumps(
                {"erreurs": [{"erreur": str(exc)}]}, ensure_ascii=False
            )
            log.exception("Job de restauration %s en erreur", job_id)
        job.finished_at = utc_now()
        db.commit()
    finally:
        db.close()
        shutil.rmtree(_dossier_tva(job_id), ignore_errors=True)


def _incomplete(report: dict) -> bool:
    return bool(
        report.get("introuvables")
        or report.get("incoherences")
        or report.get("corrompues")
        or report.get("erreurs")
    )


@router.post("/sauvegardes/restore")
def lancer_restauration(
    background: BackgroundTasks,
    demande: SauvegardeRestaurerDemande,
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Prépare une restauration. Sans `confirme`, c'est un ESSAI À BLANC : rien
    n'est écrit et le rapport dit ce qui le serait.

    Le mode « complet » est refusé si la base contient déjà des épreuves : il
    faut vider la base d'abord, ou utiliser le mode « recharge du stockage ».
    """
    if demande.mode not in MODES:
        raise HTTPException(400, f"Mode inconnu : {demande.mode}")
    if demande.dry_run and demande.confirme:
        raise HTTPException(400, "Un essai à blanc ne se confirme pas")
    if not demande.dry_run and not demande.confirme:
        raise HTTPException(
            400,
            "Une restauration en écriture exige une confirmation explicite "
            "(relancez avec confirme=true après avoir lu le rapport d'essai).",
        )
    if demande.mode == MODE_DISASTER:
        from ..db_models import EpreuveORM

        existants = db.query(EpreuveORM).count()
        if existants:
            raise HTTPException(
                409,
                f"Restauration complète impossible : la base contient déjà {existants} "
                "épreuve(s). Videz la base, ou choisissez « recharge du stockage ».",
            )

    job = SauvegardeJobORM(
        kind="restore",
        status="pending",
        source=demande.source,
        mode=demande.mode,
    )
    db.add(job)
    db.commit()
    background.add_task(
        _run_restore_job, job.id, demande.source, demande.mode, demande.confirme
    )
    log.info(
        "Restauration %s demandée (essai à blanc=%s) depuis %s",
        demande.mode,
        demande.dry_run,
        demande.source,
    )
    # Tracé d'audit pour les DEUX étapes. Un essai à blanc est tracé aussi :
    # c'est lui qui décide, et « qui a regardé quoi » compte autant que « qui
    # a écrit ». L'action distingue les deux, donc le journal se relit sans
    # ambiguïté.
    log_admin_event(
        db,
        None,
        "sauvegarde_restauration_essai" if demande.dry_run else "sauvegarde_restauration_ecriture",
        getattr(lock, "email", "") or "",
        {
            "job_id": job.id,
            "source": demande.source,
            "mode": demande.mode,
            "essai": demande.dry_run,
        },
    )
    return _job_to_dict(job)


# --------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------


@router.get("/sauvegardes/jobs")
def lister_jobs(
    limite: int = 20,
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    jobs = (
        db.query(SauvegardeJobORM)
        .order_by(SauvegardeJobORM.created_at.desc())
        .limit(min(max(limite, 1), 100))
        .all()
    )
    return {"jobs": [_job_to_dict(j) for j in jobs]}


@router.get("/sauvegardes/jobs/{job_id}")
def lire_job(job_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    job = db.query(SauvegardeJobORM).filter(SauvegardeJobORM.id == job_id).one_or_none()
    if not job:
        raise HTTPException(404, "Job de sauvegarde introuvable")
    _marquer_orphelin_si_besoin(db, job)
    return _job_to_dict(job)


# --------------------------------------------------------------------------
# Téléchargement et suppression
# --------------------------------------------------------------------------


def _verifier_prefixe(cle: str) -> str:
    """Vérifie qu'une clé visée appartient bien à l'espace des sauvegardes.

    Sans ce garde-fou, un `DELETE` mal construit pourrait viser n'importe quel
    objet du bucket : la suppression doit porter sur une SAUVEGARDE, pas sur un
    fichier du catalogue.
    """
    normalisee = (cle or "").strip().strip("/")
    if not normalisee.startswith(PREFIXE) or "/" not in normalisee[len(PREFIXE):]:
        raise HTTPException(400, "Clé de sauvegarde invalide")
    if ".." in normalisee.split("/"):
        raise HTTPException(400, "Clé de sauvegarde invalide")
    return normalisee


@router.get("/sauvegardes/telecharger/{cle:path}")
def telecharger(cle: str, lock=Depends(require_admin)):
    """Télécharge une pièce d'une sauvegarde (partie, manifeste, index ou
    procédure). URL signée si le backend en produit une, streaming FastAPI
    sinon (backend local)."""
    prefixe = _verifier_prefixe(cle)
    stockage = get_storage()
    if not stockage.exists(prefixe):
        raise HTTPException(404, "Pièce de sauvegarde introuvable")
    nom = prefixe.rsplit("/", 1)[-1]
    url = presigned_url_or_none(prefixe, content_disposition="attachment")
    if url:
        # L'URL signée porte `Content-Disposition: attachment` : le navigateur
        # télécharge au lieu d'afficher l'archive.
        return RedirectResponse(url, status_code=307)
    chemin = getattr(stockage, "local_path", lambda k: None)(prefixe)
    if chemin is None:
        raise HTTPException(501, "Le backend ne sait pas servir ce téléchargement")

    def flux():
        with chemin.open("rb") as src:
            while True:
                bloc = src.read(1024 * 1024)
                if not bloc:
                    break
                yield bloc

    return StreamingResponse(
        flux(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{nom}"'},
    )


@router.delete("/sauvegardes/{cle:path}")
def supprimer(cle: str, lock=Depends(require_admin)) -> dict:
    """Supprime une sauvegarde. Manuel et explicite : aucune politique de
    rétention automatique n'est appliquée."""
    prefixe = _verifier_prefixe(cle)
    stockage = get_storage()
    try:
        objets = stockage.list_objects(prefixe + "/")
    except NotImplementedError:
        raise HTTPException(501, "Le backend ne sait pas énumérer les clés")
    if not objets:
        raise HTTPException(404, "Sauvegarde introuvable")
    supprimes = 0
    for objet in objets:
        stockage.delete(objet["cle"])
        supprimes += 1
    log.info(
        "Sauvegarde %s supprimée (%s objet(s)) par un administrateur",
        prefixe,
        supprimes,
    )
    # Destruction de données : elle est tracée. Une suppression est
    # irrattrapable, donc « personne ne l'a fait » doit être une réponse
    # disponible, pas une absence d'entrée dans le journal.
    # Session PROPRE à la route : `supprimer` n'a pas de session en dépendance
    # (elle ne touche pas aux épreuves), et ouvrir celle de `get_db` à la main
    # la laisserait ouverte jusqu'au ramasse-miettes.
    journal = SessionLocal()
    try:
        log_admin_event(
            journal,
            None,
            "sauvegarde_supprimee",
            getattr(lock, "email", "") or "",
            {"cle": prefixe, "objets": supprimes},
        )
    finally:
        journal.close()
    return {"supprime": prefixe, "objets": supprimes}
