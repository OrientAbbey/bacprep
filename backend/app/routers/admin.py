from __future__ import annotations

import os
import uuid
from io import BytesIO
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, UploadFile, File, Form
from sqlalchemy import func
from sqlalchemy.orm import Session

try:
    from PIL import Image
    _PILLOW_OK = True
except Exception:  # pragma: no cover
    _PILLOW_OK = False

from ..core import admin_session, epreuve_files, referentiel, signing
from ..core.logging_config import get_logger
from ..db import IMPORTS_DIR, get_db, utc_now
from ..db_models import (
    AdminEventORM,
    AIConversationORM,
    ConsultationORM,
    EpreuveFiliereORM,
    EpreuveFileORM,
    EpreuveORM,
    ImportJobORM,
    PaymentORM,
    SubscriptionORM,
    UserORM,
)
from ..models import AdminLoginIn, EpreuveIn, EpreuveUpdate

router = APIRouter(prefix="/api/admin", tags=["admin"])
log = get_logger("admin")

MAX_IMAGE_BYTES = 5 * 1024 * 1024
ALLOWED_IMAGE_MIME = {"image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"}
MAX_IMAGE_WIDTH = 1600


@router.post("/login")
def admin_login(payload: AdminLoginIn, db: Session = Depends(get_db)) -> dict:
    """Connexion admin : jeton partagé (ADMIN_TOKEN) + email dans la liste
    blanche (ADMIN_EMAILS). Si un autre admin est déjà connecté (verrou
    persisté en base, voir admin_session.py), répond 409 avec qui est
    connecté depuis quand — sauf si `force=true`, qui prend le contrôle."""
    expected_token = os.getenv("ADMIN_TOKEN", "admin123")
    if payload.token != expected_token:
        raise HTTPException(401, "Jeton invalide")

    allowed = admin_session.allowed_emails()
    email = payload.email.strip().lower()
    if allowed and email not in allowed:
        raise HTTPException(401, "Adresse e-mail non autorisée")
    if not allowed:
        log.warning("ADMIN_EMAILS vide — tout email valide avec le bon jeton est autorisé")

    lock, blocker = admin_session.attempt_login(db, email, force=payload.force)
    if blocker:
        raise HTTPException(409, detail=blocker)
    return {"session_token": lock.token, "email": lock.email}


@router.post("/logout")
def admin_logout(x_admin_session: str = Header(default=""), db: Session = Depends(get_db)) -> dict:
    """Libère le verrou admin s'il correspond au jeton fourni."""
    admin_session.logout(db, x_admin_session)
    return {"ok": True}


def require_admin(x_admin_session: str = Header(default=""), db: Session = Depends(get_db)):
    """Dépendance FastAPI protégeant toutes les routes admin ci-dessous :
    valide l'en-tête X-Admin-Session contre le verrou persisté en base et
    rafraîchit son horodatage d'activité (glissement des 30 min)."""
    lock = admin_session.touch(db, x_admin_session)
    if not lock:
        raise HTTPException(401, "Session admin invalide ou expirée")
    return lock


def _log_event(db: Session, epreuve_id: str, action: str) -> None:
    """Trace une action admin dans `admin_events` (audit léger)."""
    db.add(AdminEventORM(epreuve_id=epreuve_id, action=action))
    db.commit()


def _normalize_filieres(db: Session, raw: list[str]) -> list[str]:
    """Nettoie et dédoublonne une liste de séries (normalisation casse,
    alias connus du référentiel)."""
    out: list[str] = []
    for f in raw or []:
        f = referentiel.normalize_serie(f)
        if f and f not in out:
            out.append(f)
    return out


def _replace_filieres(db: Session, epreuve_id: str, filieres: list[str]) -> None:
    db.query(EpreuveFiliereORM).filter(EpreuveFiliereORM.epreuve_id == epreuve_id).delete()
    for f in filieres:
        db.add(EpreuveFiliereORM(epreuve_id=epreuve_id, filiere=f))


@router.get("/epreuves")
def admin_list_epreuves(
    q: Optional[str] = None,
    limit: int = 30,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
) -> list[dict]:
    """Liste compacte des épreuves (tous statuts confondus, y compris
    brouillons) pour la barre latérale du back-office — limitée par
    défaut (30) et filtrable par recherche texte sur la matière/année,
    pour rester utilisable quand le catalogue grossit fortement plutôt que
    de charger systématiquement des milliers de lignes."""
    query = db.query(EpreuveORM)
    if q:
        like = f"%{q}%"
        query = query.filter((EpreuveORM.matiere.ilike(like)) | (EpreuveORM.annee.ilike(like)))
    epreuves = query.order_by(EpreuveORM.updated_at.desc()).limit(max(1, min(limit, 200))).all()
    return [
        {
            "id": e.id,
            "matiere": e.matiere,
            "annee": e.annee,
            "classe": e.classe,
            "evaluation": e.evaluation,
            "filieres": e.filieres,
            "statut": e.statut,
            "gratuit": e.gratuit,
            "corrige_disponible": e.corrige_disponible,
        }
        for e in epreuves
    ]


@router.get("/epreuves/{epreuve_id}")
def admin_get_epreuve(epreuve_id: str, db: Session = Depends(get_db), _=Depends(require_admin)) -> dict:
    """Détail complet d'une épreuve pour édition (métadonnées + contenu
    Markdown chargé du stockage + fichiers), quel que soit son statut."""
    e = db.query(EpreuveORM).filter(EpreuveORM.id == epreuve_id).one_or_none()
    if not e:
        raise HTTPException(404, "Épreuve introuvable")
    return {
        "id": e.id,
        "niveau": e.niveau,
        "classe": e.classe,
        "evaluation": e.evaluation,
        "matiere": e.matiere,
        "annee": e.annee,
        "session": e.session,
        "duree": e.duree,
        "coefficient": e.coefficient,
        "gratuit": e.gratuit,
        "statut": e.statut,
        "filieres": e.filieres,
        "contenu_markdown": epreuve_files.read_document_content(db, e.id, "sujet"),
        "corrige_markdown": epreuve_files.read_document_content(db, e.id, "corrige"),
        "assets": [
            {
                "id": f.id,
                "cible": f.cible,
                "format": f.format,
                "filename": f.filename,
                "url": signing.signed_file_url(f.id),
            }
            for f in e.files_rel
        ],
    }


@router.post("/epreuves")
def admin_create_epreuve(payload: EpreuveIn, db: Session = Depends(get_db), _=Depends(require_admin)) -> dict:
    """Crée une épreuve en brouillon (jamais publiée directement — voir
    `admin_publish`). L'id est un identifiant court unique utilisé dans les
    storage_key ; le contenu Markdown fourni est écrit dans le stockage."""
    e = EpreuveORM(
        niveau=referentiel.normalize_niveau(payload.niveau),
        classe=referentiel.normalize_classe(payload.classe) or "terminale",
        evaluation=referentiel.normalize_evaluation(payload.evaluation),
        matiere=payload.matiere.strip(),
        annee=payload.annee.strip(),
        session=payload.session,
        duree=payload.duree,
        coefficient=payload.coefficient,
        gratuit=payload.gratuit,
        statut=payload.statut if payload.statut in ("brouillon", "a_reviser") else "brouillon",
    )
    db.add(e)
    db.flush()

    epreuve_files.write_document(db, e, "sujet", payload.contenu_markdown or "")
    if payload.corrige_markdown:
        epreuve_files.write_document(db, e, "corrige", payload.corrige_markdown)
    _replace_filieres(db, e.id, _normalize_filieres(db, payload.filieres))

    db.commit()
    _log_event(db, e.id, "created")
    log.info("Épreuve créée: %s (%s/%s/%s)", e.id, e.niveau, e.classe, e.evaluation)
    return {"id": e.id}


@router.put("/epreuves/{epreuve_id}")
def admin_update_epreuve(
    epreuve_id: str, payload: EpreuveUpdate, db: Session = Depends(get_db), _=Depends(require_admin)
) -> dict:
    """Mise à jour partielle (seuls les champs fournis sont modifiés,
    `exclude_unset=True`) — remplace entièrement l'ensemble des séries si
    ce champ est fourni, et réécrit les documents Markdown si leur contenu
    est fourni. Changer niveau/classe/année DÉPLACE les fichiers (clé de
    stockage recalculée)."""
    e = db.query(EpreuveORM).filter(EpreuveORM.id == epreuve_id).one_or_none()
    if not e:
        raise HTTPException(404, "Épreuve introuvable")

    data = payload.model_dump(exclude_unset=True)
    filieres = data.pop("filieres", None)
    contenu = data.pop("contenu_markdown", None)
    corrige = data.pop("corrige_markdown", None)

    relocations = {}
    for key in ("niveau", "classe", "annee"):
        if key in data:
            relocations[key] = (getattr(e, key), data[key])
            setattr(e, key, data.pop(key))

    for key, value in data.items():
        setattr(e, key, value)

    # Réécrit les documents fournis (sujet/corrige) — la clé de stockage est
    # recalculée après d'éventuelles modifications de niveau/classe/année.
    db.flush()
    if contenu is not None:
        epreuve_files.write_document(db, e, "sujet", contenu)
    if corrige is not None:
        epreuve_files.write_document(db, e, "corrige", corrige)

    if relocations:
        _relocate_files(db, e)

    if filieres is not None:
        _replace_filieres(db, epreuve_id, _normalize_filieres(db, filieres))

    e.updated_at = utc_now()
    db.commit()
    _log_event(db, epreuve_id, "updated")
    return {"ok": True}


def _relocate_files(db: Session, e: EpreuveORM) -> None:
    """Après un changement de niveau/classe/année, copie chaque fichier vers
    sa nouvelle clé canonique puis supprime l'ancien objet."""
    storage = epreuve_files.get_storage()
    for f in e.files_rel:
        if f.format == epreuve_files.DOCUMENT_FORMAT:
            new_key = epreuve_files.document_key(e, f.cible)
        else:
            new_key = epreuve_files.image_key(e, f.cible, os.path.basename(f.storage_key))
        if new_key == f.storage_key:
            continue
        try:
            data = storage.get_bytes(f.storage_key)
        except Exception as exc:
            log.warning("Relocalisation impossible (%s): %s", f.storage_key, exc)
            continue
        storage.put_bytes(new_key, data, f.mime_type)
        old_key = f.storage_key
        f.storage_key = new_key
        db.add(f)
        try:
            storage.delete(old_key)
        except Exception as exc:
            log.warning("Suppression ancien objet %s impossible: %s", old_key, exc)


@router.post("/epreuves/{epreuve_id}/publish")
def admin_publish(epreuve_id: str, db: Session = Depends(get_db), _=Depends(require_admin)) -> dict:
    """Publie une épreuve — exige un document sujet présent (fichier .md)
    et au moins une série ; le corrigé n'est JAMAIS requis pour publier."""
    e = db.query(EpreuveORM).filter(EpreuveORM.id == epreuve_id).one_or_none()
    if not e:
        raise HTTPException(404, "Épreuve introuvable")
    if not epreuve_files.get_document(db, epreuve_id, "sujet"):
        raise HTTPException(400, "Un sujet (document Markdown) est obligatoire pour publier")
    if not e.filieres:
        raise HTTPException(400, "Au moins une série est requise pour publier")
    e.statut = "publie"
    db.commit()
    _log_event(db, epreuve_id, "published")
    return {"ok": True}


@router.post("/epreuves/{epreuve_id}/unpublish")
def admin_unpublish(epreuve_id: str, db: Session = Depends(get_db), _=Depends(require_admin)) -> dict:
    """Retire une épreuve du catalogue élève (repasse en "à réviser") sans
    la supprimer."""
    e = db.query(EpreuveORM).filter(EpreuveORM.id == epreuve_id).one_or_none()
    if not e:
        raise HTTPException(404, "Épreuve introuvable")
    e.statut = "a_reviser"
    db.commit()
    _log_event(db, epreuve_id, "unpublished")
    return {"ok": True}


@router.delete("/epreuves/{epreuve_id}")
def admin_delete_epreuve(epreuve_id: str, db: Session = Depends(get_db), _=Depends(require_admin)) -> dict:
    """Supprime définitivement une épreuve — les fichiers du stockage
    (documents + images) et les lignes liées partent avec elle."""
    e = db.query(EpreuveORM).filter(EpreuveORM.id == epreuve_id).one_or_none()
    if not e:
        raise HTTPException(404, "Épreuve introuvable")
    # Tables référençant l'épreuve et SANS cascade ORM — à traiter à la main
    # avant la suppression, sinon la contrainte de clé étrangère la fait
    # échouer (liste exhaustive : subscriptions, ai_conversations,
    # consultations ; filières et fichiers partent en cascade ORM) :
    # - les abonnements « épreuve précise » perdent leur cible (le paiement,
    #   lui, reste dans l'historique) ;
    # - l'historique de consultation et les discussions IA de cette épreuve
    #   sont supprimés (plus de sens sans leur épreuve).
    db.query(SubscriptionORM).filter(SubscriptionORM.epreuve_id == epreuve_id).update(
        {SubscriptionORM.epreuve_id: None}
    )
    db.query(AIConversationORM).filter(AIConversationORM.epreuve_id == epreuve_id).delete()
    db.query(ConsultationORM).filter(ConsultationORM.epreuve_id == epreuve_id).delete()
    for f in list(e.files_rel):
        epreuve_files.delete_file(db, f)
    db.delete(e)  # cascade ORM : filières et fichiers restants supprimés avec l'épreuve
    db.commit()
    _log_event(db, epreuve_id, "deleted")
    log.info("Épreuve supprimée: %s", epreuve_id)
    return {"ok": True}


@router.post("/epreuves/{epreuve_id}/images")
async def admin_upload_image(
    epreuve_id: str,
    file: UploadFile = File(...),
    cible: str = Form(...),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
) -> dict:
    """Upload d'image d'illustration ciblée sujet/corrigé : valide le type
    MIME et la taille (5 Mo max), redimensionne à 1600px de large maximum
    et recompresse via Pillow (repli sur le fichier brut si Pillow échoue),
    puis enregistre le fichier dans le stockage objet + la table
    `epreuve_files`. Un avertissement est retourné si le même fichier
    (checksum) existe déjà sur une autre épreuve (détection de doublons)."""
    if cible not in ("sujet", "corrige"):
        raise HTTPException(400, "cible doit être 'sujet' ou 'corrige'")
    e = db.query(EpreuveORM).filter(EpreuveORM.id == epreuve_id).one_or_none()
    if not e:
        raise HTTPException(404, "Épreuve introuvable")
    if file.content_type not in ALLOWED_IMAGE_MIME:
        raise HTTPException(400, f"Type de fichier non autorisé: {file.content_type}")

    raw = await file.read()
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(400, "Fichier trop volumineux (5 Mo max)")

    data = raw
    mime = file.content_type
    if _PILLOW_OK and file.content_type != "image/svg+xml":
        try:
            img = Image.open(BytesIO(raw))
            if img.width > MAX_IMAGE_WIDTH:
                ratio = MAX_IMAGE_WIDTH / img.width
                img = img.resize((MAX_IMAGE_WIDTH, int(img.height * ratio)))
            buf = BytesIO()
            img.save(buf, optimize=True)
            data = buf.getvalue()
            mime = Image.MIME.get(img.format, file.content_type)
        except Exception as exc:
            log.warning("Optimisation Pillow échouée pour %s, sauvegarde brute: %s", file.filename, exc)

    ext = os.path.splitext(file.filename or "")[1] or ".png"
    row = epreuve_files.save_image(
        db, e, cible, f"{uuid.uuid4().hex[:8]}{ext}", data, mime
    )
    db.commit()
    _log_event(db, epreuve_id, f"image_uploaded_{cible}")

    # Détection de doublons : même contenu (SHA-256) déjà importé ailleurs ?
    doublon = (
        db.query(EpreuveFileORM)
        .filter(
            EpreuveFileORM.checksum_sha256 == row.checksum_sha256,
            EpreuveFileORM.epreuve_id != epreuve_id,
        )
        .one_or_none()
    )
    return {
        "id": row.id,
        "url": signing.signed_file_url(row.id),
        "filename": row.filename,
        "cible": cible,
        "doublon_de": doublon.epreuve_id if doublon else None,
    }


@router.post("/epreuves/{epreuve_id}/documents")
async def admin_upload_document(
    epreuve_id: str,
    file: UploadFile = File(...),
    cible: str = Form(...),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
) -> dict:
    """Upload d'un DOCUMENT Markdown (.md) en remplacement du sujet ou du
    corrigé — même effet qu'un enregistrement via l'éditeur texte. (Le
    périmètre produit est Markdown uniquement : pas de PDF ni HTML.)"""
    if cible not in ("sujet", "corrige"):
        raise HTTPException(400, "cible doit être 'sujet' ou 'corrige'")
    e = db.query(EpreuveORM).filter(EpreuveORM.id == epreuve_id).one_or_none()
    if not e:
        raise HTTPException(404, "Épreuve introuvable")
    name = (file.filename or "").lower()
    if not name.endswith(".md") and file.content_type not in ("text/markdown", "text/plain"):
        raise HTTPException(400, "Seuls les fichiers Markdown (.md) sont acceptés")

    raw = await file.read()
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(400, "Fichier trop volumineux (5 Mo max)")
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(400, "Le fichier doit être encodé en UTF-8") from exc

    row = epreuve_files.write_document(db, e, cible, content)
    db.commit()
    _log_event(db, epreuve_id, f"document_uploaded_{cible}")
    return {"ok": True, "cible": cible, "size": len(raw), "cree": bool(row)}


@router.delete("/files/{file_id}")
def admin_delete_file(file_id: str, db: Session = Depends(get_db), _=Depends(require_admin)) -> dict:
    """Supprime un fichier d'épreuve (objet du stockage + ligne en base)."""
    f = db.query(EpreuveFileORM).filter(EpreuveFileORM.id == file_id).one_or_none()
    if not f:
        raise HTTPException(404, "Fichier introuvable")
    epreuve_id = f.epreuve_id
    epreuve_files.delete_file(db, f)
    db.commit()
    _log_event(db, epreuve_id, f"file_deleted_{f.cible}")
    return {"ok": True}


@router.get("/stats")
def admin_stats(db: Session = Depends(get_db), _=Depends(require_admin)) -> dict:
    """Compteurs pour le tableau de bord admin (utilisateurs, abonnements
    actifs, revenu confirmé, épreuves par statut et par classe)."""
    par_classe = dict(
        db.query(EpreuveORM.classe, func.count(EpreuveORM.id))
        .filter(EpreuveORM.statut == "publie")
        .group_by(EpreuveORM.classe)
        .all()
    )
    return {
        "utilisateurs": db.query(UserORM).count(),
        "abonnements_actifs": db.query(SubscriptionORM).filter(SubscriptionORM.statut == "active").count(),
        "revenu_total_fcfa": sum(
            p.montant for p in db.query(PaymentORM).filter(PaymentORM.statut == "confirmed").all()
        ),
        "epreuves_par_statut": {
            statut: db.query(EpreuveORM).filter(EpreuveORM.statut == statut).count()
            for statut in ("brouillon", "a_reviser", "publie")
        },
        "epreuves_par_classe": par_classe,
    }


# ---------- Import massif ----------

MAX_ZIP_BYTES = 200 * 1024 * 1024  # 200 Mo


def _job_to_dict(job: ImportJobORM) -> dict:
    import json as _json

    report = {}
    if job.report_json and job.report_json != "{}":
        try:
            report = _json.loads(job.report_json)
        except ValueError:
            report = {}
    return {
        "id": job.id,
        "filename": job.filename,
        "status": job.status,
        "created_at": job.created_at,
        "finished_at": job.finished_at,
        "report": report,
    }


def _run_import_job(job_id: str, extract_dir: str) -> None:
    """Tâche de fond : exécute l'import du dossier extrait puis persiste le
    rapport. Utilise SA propre session (une tâche de fond ne peut pas
    réutiliser la session de la requête HTTP qui l'a planifiée)."""
    import json

    from pathlib import Path

    from ..core.import_service import run_import
    from ..db import SessionLocal

    db = SessionLocal()
    try:
        job = db.query(ImportJobORM).filter(ImportJobORM.id == job_id).one_or_none()
        if not job:
            return
        job.status = "running"
        db.commit()
        try:
            report = run_import(db, Path(extract_dir), dry_run=False)
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


@router.post("/import")
async def admin_import_zip(
    background: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
) -> dict:
    """Import massif via l'interface admin : reçoit un dossier compressé
    (zip), l'extrait dans la zone d'import et planifie le traitement de
    fond (même moteur que le script CLI `python -m app.scripts.importer`).
    Retourne immédiatement l'id du job — le statut et le rapport détaillé
    (créées/doublons/erreurs/métadonnées manquantes) se lisent via
    GET /api/admin/import/jobs/{id}."""
    name = file.filename or "import.zip"
    if not name.lower().endswith(".zip"):
        raise HTTPException(400, "Le fichier doit être une archive .zip")

    raw = await file.read()
    if len(raw) > MAX_ZIP_BYTES:
        raise HTTPException(400, "Archive trop volumineuse (200 Mo max)")

    job = ImportJobORM(filename=name, status="pending")
    db.add(job)
    db.commit()

    job_dir = IMPORTS_DIR / "jobs" / job.id
    extract_dir = job_dir / "contenu"
    extract_dir.mkdir(parents=True, exist_ok=True)

    import zipfile

    try:
        with zipfile.ZipFile(BytesIO(raw)) as zf:
            # Extraction sécurisée : rejette les entrées absolues ou avec
            # '..' (zip slip) et plafonne la taille décompressée.
            total = 0
            for info in zf.infolist():
                if info.is_dir():
                    continue
                target = (extract_dir / info.filename).resolve()
                target.relative_to(extract_dir.resolve())
                total += info.file_size
                if total > MAX_ZIP_BYTES:
                    raise HTTPException(400, "Contenu décompressé trop volumineux (200 Mo max)")
            zf.extractall(extract_dir)
    except HTTPException:
        raise
    except zipfile.BadZipFile as exc:
        job.status = "error"
        job.report_json = '{"erreurs": [{"fichier": "", "erreur": "archive zip invalide"}]}'
        job.finished_at = utc_now()
        db.commit()
        raise HTTPException(400, "Archive zip invalide") from exc

    # Pas d'élagage de dossier racine : `_parse_path` identifie chaque
    # segment par sa nature (année, classe, matière) quelle que soit sa
    # position — un dossier racine du type "2022" ne doit jamais être
    # confondu avec un simple préfixe d'archive.
    background.add_task(_run_import_job, job.id, str(extract_dir))
    log.info("Job d'import %s planifié (%s, %d o)", job.id, name, len(raw))
    return {"job_id": job.id, "status": "pending"}


@router.get("/import/jobs")
def admin_list_import_jobs(db: Session = Depends(get_db), _=Depends(require_admin)) -> list[dict]:
    """Tous les jobs d'import massif, les plus récents d'abord."""
    jobs = db.query(ImportJobORM).order_by(ImportJobORM.created_at.desc()).limit(50).all()
    return [_job_to_dict(j) for j in jobs]


@router.get("/import/jobs/{job_id}")
def admin_get_import_job(job_id: str, db: Session = Depends(get_db), _=Depends(require_admin)) -> dict:
    """Statut + rapport détaillé d'un job d'import massif."""
    job = db.query(ImportJobORM).filter(ImportJobORM.id == job_id).one_or_none()
    if not job:
        raise HTTPException(404, "Job introuvable")
    return _job_to_dict(job)
