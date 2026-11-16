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
import re
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import RedirectResponse, StreamingResponse
from sqlalchemy.orm import Session

from ..core.export_service import (
    NOM_INDEX,
    NOM_MANIFESTE,
    NOM_PRET,
    PREFIXE,
)
from ..core.job_runner import executer
from ..core.logging_config import get_logger
from ..core.restore_service import (
    MODES,
    MODE_DISASTER,
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

# À partir de cette date, une sauvegarde doit porter le marqueur `_READY`
# pour apparaître dans l'inventaire. Les archives antérieures restent
# restaurables (compatibilité avec les sauvegardes créées avant l'instrumentation).
READY_OBLIGATOIRE_DEPUIS = "2026-11-16T000000Z"
_HORODATAGE_SAUVEGARDE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{6}Z)")


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
        "phase": job.phase or "",
        "duration_ms": job.duration_ms,
        "attempts": job.attempts or 0,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "heartbeat_at": job.heartbeat_at.isoformat() if job.heartbeat_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


# --------------------------------------------------------------------------
# Inventaire des sauvegardes existantes
# --------------------------------------------------------------------------


def _iso(valeur) -> Optional[str]:
    if valeur is None:
        return None
    return valeur.isoformat() if hasattr(valeur, "isoformat") else str(valeur)


class SauvegardeIgnoree(Exception):
    """Une sauvegarde présente dans le stockage n'est pas exploitable.

    Lever plutôt que retourner `None` permet de dire POURQUOI elle est
    ignorée : « en cours d'écriture », « export interrompu » ou « index
    illisible » n'appellent pas la même réaction de l'administrateur.
    """


def _resume(prefixe: str, stockage) -> SauvegardeResume:
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
    except StorageError as exc:
        raise SauvegardeIgnoree("index ou manifeste introuvable") from exc
    except (ValueError, UnicodeDecodeError) as exc:
        raise SauvegardeIgnoree("index ou manifeste illisible") from exc

    if not isinstance(index, dict) or not isinstance(manifest, dict):
        raise SauvegardeIgnoree("structure de sauvegarde inattendue")
    parties = index.get("parties")
    if not isinstance(parties, list):
        raise SauvegardeIgnoree("index sans liste de parties")

    fiches = []
    for partie in parties:
        if not isinstance(partie, dict) or not partie.get("nom"):
            raise SauvegardeIgnoree("partie décrite sans nom")
        fiches.append(
            {
                "nom": str(partie["nom"]),
                "octets": int(partie.get("octets") or 0),
                "sha256": partie.get("sha256"),
                "nb_fichiers": int(partie.get("nb_fichiers") or 0),
            }
        )
    return SauvegardeResume(
        cle=prefixe,
        nom=prefixe.rsplit("/", 1)[-1],
        taille_octets=0,
        modifie_le=None,
        parties=fiches,
        epreuves=int(manifest.get("epreuve_count") or 0),
        fichiers=int(manifest.get("fichier_count") or 0),
    )


def _lister_sauvegardes(db: Session) -> tuple[list[dict], list[dict]]:
    """Inventaire des sauvegardes réellement restaurables.

    Retourne `(sauvegardes, ignorees)`. Les ignorées portent leur raison :
    l'écran peut alors distinguer une sauvegarde en cours d'écriture d'une
    archive corrompue, au lieu d'afficher un message unique et faux.
    """
    stockage = get_storage()
    debut = time.perf_counter()
    lectures = 0
    try:
        objets = stockage.list_objects(PREFIXE)
    except NotImplementedError:
        log.warning("Le backend de stockage ne sait pas énumérer les clés")
        return [], []
    except Exception as exc:
        # S3 indisponible, identifiants expirés, réseau coupé : ce n'est PAS
        # « aucune sauvegarde ». Le dire clairement évite de faire croire à
        # une perte de données.
        log.exception("Inventaire impossible : stockage injoignable")
        raise HTTPException(
            503,
            "Stockage momentanément indisponible — l'inventaire ne peut pas "
            f"être lu ({type(exc).__name__}). Réessaie dans quelques instants.",
        ) from exc

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

    # État des exports connus, par destination. Un export écrit le manifeste,
    # puis les parties, puis l'index : tant qu'il tourne, son dossier est
    # partiel. `_READY` est la preuve de complétude, mais les sauvegardes
    # antérieures à ce marqueur n'en ont pas — l'état du job permet alors de
    # distinguer « ancienne sauvegarde » de « travail en cours ».
    etats: dict[str, str] = {}
    destinations = list(groupes)
    if destinations:
        for job in (
            db.query(SauvegardeJobORM)
            .filter(
                SauvegardeJobORM.kind == "export",
                SauvegardeJobORM.destination.in_(destinations),
            )
            .order_by(SauvegardeJobORM.created_at.desc())
            .all()
        ):
            etats.setdefault(job.destination, job.status)

    resumes: list[dict] = []
    ignorees: list[dict] = []
    # Antichronologique : la sauvegarde la plus récente en premier.
    for prefixe in sorted(groupes, reverse=True):
        etat = etats.get(prefixe)
        pret = False
        try:
            lectures += 1
            pret = stockage.exists(f"{prefixe}/{NOM_PRET}")
        except Exception:
            # `exists` peut échouer indépendamment : on laisse alors la
            # décision au couple index/manifeste ci-dessous.
            pret = False
        if not pret:
            if etat in ("pending", "running"):
                ignorees.append({"cle": prefixe, "raison": "sauvegarde en cours d'écriture"})
                continue
            if etat == "error":
                ignorees.append({"cle": prefixe, "raison": "export interrompu ou incomplet"})
                continue
            # Aucun job connu : distinguer une archive historique (acceptée
            # si index et manifeste sont lisibles) d'une sauvegarde récente
            # dont le marqueur final n'a jamais été écrit — celle-ci est
            # incomplète et ne doit pas être proposée à la restauration.
            horodatage = _HORODATAGE_SAUVEGARDE.match(prefixe.rsplit("/", 1)[-1])
            if horodatage and horodatage.group(1) >= READY_OBLIGATOIRE_DEPUIS:
                ignorees.append({"cle": prefixe, "raison": "marqueur final _READY absent"})
                continue
        try:
            lectures += 2  # index + manifeste
            resume = _resume(prefixe, stockage)
        except SauvegardeIgnoree as exc:
            log.warning("Sauvegarde ignorée (%s) : %s", exc, prefixe)
            ignorees.append({"cle": prefixe, "raison": str(exc)})
            continue
        except Exception as exc:  # structure inattendue, valeur non convertible…
            log.exception("Sauvegarde ignorée (erreur inattendue) : %s", prefixe)
            ignorees.append(
                {"cle": prefixe, "raison": f"sauvegarde illisible ({type(exc).__name__})"}
            )
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
    log.info(
        "Inventaire des sauvegardes : %d objet(s), %d sauvegarde(s), %d ignorée(s), "
        "%d lecture(s) — %.0f ms",
        len(objets),
        len(resumes),
        len(ignorees),
        lectures,
        (time.perf_counter() - debut) * 1000,
    )
    return resumes, ignorees


@router.get("/sauvegardes")
def lister(
    db: Session = Depends(get_db),
    client=Depends(require_admin),
) -> dict:
    """Inventaire des sauvegardes : la liste, le volume total occupé et les
    sauvegardes ignorées avec leur raison.

    Le volume est affiché sans aucune purge automatique : la suppression reste
    une décision de l'administrateur. Une politique de rétention décidée par
    le système finit toujours par effacer la bonne sauvegarde au mauvais moment.
    """
    sauvegardes, ignorees = _lister_sauvegardes(db)
    return {
        "sauvegardes": sauvegardes,
        "total_octets": sum(s["taille_octets"] for s in sauvegardes),
        "ignorees": ignorees,
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
    job.params_json = "{}"
    db.commit()
    background.add_task(executer, "export", job.id)
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
        params_json=json.dumps({"confirmer": bool(demande.confirme)}, ensure_ascii=False),
    )
    db.add(job)
    db.commit()
    background.add_task(executer, "restore", job.id)
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
