"""Routes admin : gestion des épreuves (CRUD, publication, uploads
images/documents, suppression de fichiers). Découpé de l'ancien admin.py
monolithique ; les dépendances partagées vivent dans `deps.py`, le
traitement Pillow dans `core/images.py`.
"""
from __future__ import annotations

import os
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core import epreuve_files, images, referentiel, referentiel_options, signing
from ..core.logging_config import get_logger
from ..db import get_db, utc_now
from ..db_models import (
    AdminAIConversationORM,
    AIConversationORM,
    ConsultationORM,
    EpreuveFiliereORM,
    EpreuveFileORM,
    EpreuveORM,
    NoteORM,
    NotificationORM,
    SignalementORM,
    SubscriptionORM,
)
from ..models import EpreuveIn, EpreuveUpdate, SujetIn
from .deps import get_epreuve_or_404, log_admin_event, require_admin

router = APIRouter(prefix="/api/admin", tags=["admin-epreuves"])
log = get_logger("admin_epreuves")

MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
STATUTS_VALIDES = ("brouillon", "a_reviser", "publie")


def _normalize_filieres(raw: list[str]) -> list[str]:
    """Nettoie et dédoublonne une liste de séries (normalisation casse,
    alias connus du référentiel)."""
    out: list[str] = []
    for f in raw or []:
        f = referentiel.normalize_serie(f)
        if f and f not in out:
            out.append(f)
    return out


def _read_bounded(file: UploadFile, max_bytes: int) -> bytes:
    """Lit au plus max_bytes+1 octets d'un upload : le dépassement est
    détecté sans jamais charger plus que nécessaire en RAM."""
    raw = file.file.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise HTTPException(400, "Fichier trop volumineux (5 Mo max)")
    return raw


def _replace_filieres(db: Session, epreuve_id: str, filieres: list[str]) -> None:
    db.query(EpreuveFiliereORM).filter(EpreuveFiliereORM.epreuve_id == epreuve_id).delete()
    for f in filieres:
        db.add(EpreuveFiliereORM(epreuve_id=epreuve_id, filiere=f))


def _auto_ajout_referentiel(db: Session, matiere: str, session: str, filieres: list[str]) -> None:
    """Après une sauvegarde, mémorise toute valeur saisie hors référentiel
    (matière, session, séries) dans `referentiel_options` — best-effort et
    sans jamais bloquer l'enregistrement : la liste s'alimente à l'usage,
    les formulaires d'épreuve proposeront ces valeurs la fois suivante."""
    referentiel_options.ensure_option(db, "matiere", matiere)
    referentiel_options.ensure_option(db, "session", session)
    for f in filieres:
        referentiel_options.ensure_option(db, "serie", f)


def _has_any_sujet(db: Session, epreuve_id: str) -> bool:
    """Vrai si au moins UN document sujet (n'importe quel index) existe —
    la présence d'une ligne `epreuve_files` équivaut à un contenu non vide
    (l'écriture vide supprime la ligne, voir `write_document`)."""
    return (
        db.query(EpreuveFileORM)
        .filter(
            EpreuveFileORM.epreuve_id == epreuve_id,
            EpreuveFileORM.cible == "sujet",
            EpreuveFileORM.format == epreuve_files.DOCUMENT_FORMAT,
        )
        .count()
        > 0
    )


@router.get("/epreuves")
def admin_list_epreuves(
    q: Optional[str] = None,
    statut: Optional[str] = None,
    limit: int = 30,
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> list[dict]:
    """Liste compacte des épreuves (tous statuts par défaut, filtrable par
    `statut` : brouillon|a_reviser|publie) pour la barre latérale du
    back-office — limitée par défaut (30) et filtrable par recherche texte
    sur la matière/année, pour rester utilisable quand le catalogue grossit
    fortement plutôt que de charger systématiquement des milliers de lignes."""
    query = db.query(EpreuveORM)
    if statut in STATUTS_VALIDES:
        query = query.filter(EpreuveORM.statut == statut)
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
            "nb_sujets": e.nb_sujets,
        }
        for e in epreuves
    ]


@router.get("/epreuves/counts")
def admin_epreuve_counts(db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    """Compteurs d'épreuves par statut (tous, brouillon, à réviser,
    publiées) — alimente les puces de la barre latérale du back-office
    (« Brouillon (50) », ...) pour cadrer la liste sans tout charger.

    NB : DOIT rester déclaré avant /epreuves/{epreuve_id} — FastAPI résout
    les routes dans l'ordre de déclaration et « counts » matcherait sinon
    le paramètre {epreuve_id}."""
    counts = dict(
        db.query(EpreuveORM.statut, func.count(EpreuveORM.id)).group_by(EpreuveORM.statut).all()
    )
    total = sum(counts.values())
    return {
        "tous": total,
        "brouillon": counts.get("brouillon", 0),
        "a_reviser": counts.get("a_reviser", 0),
        "publie": counts.get("publie", 0),
    }


@router.get("/epreuves/{epreuve_id}")
def admin_get_epreuve(epreuve_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    """Détail complet d'une épreuve pour édition (métadonnées + contenu
    Markdown chargé du stockage + fichiers), quel que soit son statut.
    Les IMAGES (`assets`, galerie) sont séparées des DOCUMENTS Markdown
    (`documents`, liste texte) : renvoyer les .md dans la galerie faisait
    apparaître « sujet.md » comme une image rattachée au sujet/corrigé.

    Le tableau `sujets` contient l'ensemble des sujets (chacun avec son
    corrigé optionnel). `contenu_markdown`/`corrige_markdown` continuent
    d'être renseignés pour rétrocompatibilité (index 0)."""
    e = get_epreuve_or_404(db, epreuve_id)

    # Constitution du tableau `sujets` : un par index ayant au moins un
    # document (sujet ou corrigé). S'assure qu'au moins l'index 0 est
    # présent pour les épreuves créées avant ce chantier.
    indices = sorted({f.sujet_index for f in e.files_rel if f.format == "md"})
    if not indices:
        indices = [0]
    sujets = [
        {
            "index": idx,
            "contenu_markdown": epreuve_files.read_document_content(db, e.id, "sujet", idx),
            "corrige_markdown": epreuve_files.read_document_content(db, e.id, "corrige", idx),
            "corrige_disponible": epreuve_files.get_document(db, e.id, "corrige", idx) is not None,
        }
        for idx in indices
    ]
    sujet0 = sujets[0] if sujets else {}

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
        "contenu_markdown": sujet0.get("contenu_markdown", ""),
        "corrige_markdown": sujet0.get("corrige_markdown", ""),
        "sujets": sujets,
        "nb_sujets": e.nb_sujets,
        "assets": [
            {
                "id": f.id,
                "cible": f.cible,
                "format": f.format,
                "filename": f.filename,
                "url": signing.signed_file_url(f.id, e.id, e.statut),
                "size_bytes": f.size_bytes,
                "width": f.width,
                "height": f.height,
                "mime_type": f.mime_type,
            }
            for f in e.files_rel
            if f.format == "image"
        ],
        "documents": [
            {
                "id": f.id,
                "cible": f.cible,
                "filename": f.filename,
                "size_bytes": f.size_bytes,
                "uploaded_at": f.uploaded_at,
            }
            for f in e.files_rel
            if f.format == "md"
        ],
    }


@router.post("/epreuves")
def admin_create_epreuve(payload: EpreuveIn, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    """Crée une épreuve en brouillon (jamais publiée directement — voir
    `admin_publish`). L'id est un identifiant court unique utilisé dans les
    storage_key ; le contenu Markdown fourni est écrit dans le stockage.

    Le champ optionnel `sujets` (tableau de SujetIn) prend le dessus sur
    les champs plats `contenu_markdown`/`corrige_markdown` quand il est
    fourni, permettant la création directe d'une épreuve multi-sujets."""
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

    filieres = _normalize_filieres(payload.filieres)

    if payload.sujets is not None:
        for s in payload.sujets:
            epreuve_files.write_document(db, e, "sujet", s.contenu_markdown or "", s.index)
            if s.corrige_markdown:
                epreuve_files.write_document(db, e, "corrige", s.corrige_markdown, s.index)
    else:
        epreuve_files.write_document(db, e, "sujet", payload.contenu_markdown or "")
        if payload.corrige_markdown:
            epreuve_files.write_document(db, e, "corrige", payload.corrige_markdown)
    _replace_filieres(db, e.id, filieres)

    db.commit()
    _auto_ajout_referentiel(db, e.matiere, e.session or "", filieres or [])
    log_admin_event(
        db, e.id, "created", email=lock.email,
        details={"matiere": e.matiere, "classe": e.classe, "annee": e.annee},
    )
    log.info("Épreuve créée: %s (%s/%s/%s)", e.id, e.niveau, e.classe, e.evaluation)
    return {"id": e.id}


@router.put("/epreuves/{epreuve_id}")
def admin_update_epreuve(
    epreuve_id: str, payload: EpreuveUpdate, db: Session = Depends(get_db), lock=Depends(require_admin)
) -> dict:
    """Mise à jour partielle (seuls les champs fournis sont modifiés,
    `exclude_unset=True`) — remplace entièrement l'ensemble des séries si
    ce champ est fourni, et réécrit les documents Markdown si leur contenu
    est fourni. Changer niveau/classe/année DÉPLACE les fichiers (clé de
    stockage recalculée).

    Contrairement à une première version qui écrivait `statut` tel quel,
    il est validé ; niveau/classe/évaluation passent par le référentiel
    comme à la création (symétrie create/update)."""
    e = get_epreuve_or_404(db, epreuve_id)

    data = payload.model_dump(exclude_unset=True)
    filieres = data.pop("filieres", None)
    contenu = data.pop("contenu_markdown", None)
    corrige = data.pop("corrige_markdown", None)
    sujets_payload = data.pop("sujets", None)

    # Audit « QUOI a été modifié » : capture des valeurs avant application
    # pour ne tracer que les champs réellement changés.
    avant = {k: getattr(e, k) for k in data}
    champs_modifies = [k for k, v in data.items() if v != avant.get(k)]
    if filieres is not None:
        champs_modifies.append("filieres")
    if contenu is not None:
        champs_modifies.append("contenu_markdown")
    if corrige is not None:
        champs_modifies.append("corrige_markdown")
    if sujets_payload is not None:
        champs_modifies.append("sujets")

    if "statut" in data and data["statut"] not in STATUTS_VALIDES:
        raise HTTPException(400, "statut invalide")
    if "niveau" in data and data["niveau"]:
        data["niveau"] = referentiel.normalize_niveau(data["niveau"])
    if "classe" in data and data["classe"]:
        data["classe"] = referentiel.normalize_classe(data["classe"]) or data["classe"]
    if "evaluation" in data and data["evaluation"]:
        data["evaluation"] = referentiel.normalize_evaluation(data["evaluation"])

    relocations = {}
    for key in ("niveau", "classe", "annee"):
        if key in data:
            relocations[key] = (getattr(e, key), data[key])
            setattr(e, key, data.pop(key))

    for key, value in data.items():
        setattr(e, key, value)

    # Réécrit les documents fournis (sujet/corrigé) — la clé de stockage est
    # recalculée après d'éventuelles modifications de niveau/classe/année.
    db.flush()
    if sujets_payload is not None:
        _replace_sujets(db, e, sujets_payload)
    else:
        if contenu is not None:
            epreuve_files.write_document(db, e, "sujet", contenu)
        if corrige is not None:
            epreuve_files.write_document(db, e, "corrige", corrige)

    if relocations:
        _relocate_files(db, e)

    if filieres is not None:
        _replace_filieres(db, epreuve_id, _normalize_filieres(filieres))

    e.updated_at = utc_now()
    db.commit()
    _auto_ajout_referentiel(
        db, e.matiere, e.session or "", _normalize_filieres(filieres) if filieres is not None else []
    )
    log_admin_event(db, epreuve_id, "updated", email=lock.email, details={"champs": champs_modifies})
    return {"ok": True}


def _replace_sujets(db: Session, e: EpreuveORM, sujets: list[SujetIn]) -> None:
    """Remplace L'ENSEMBLE des documents Markdown d'une épreuve (sujets +
    corrigés) par ceux du tableau fourni : les documents absents du tableau
    sont supprimés (objets du stockage compris), les présents sont réécrits
    à leur index exact. C'est la base du multi-sujets : l'admin sauvegarde
    la collection complète et le serveur aligne la base sur ce qu'elle
    contient."""
    for f in list(e.files_rel):
        if f.format == epreuve_files.DOCUMENT_FORMAT:
            epreuve_files.delete_file(db, f)
    for s in sujets:
        epreuve_files.write_document(db, e, "sujet", s.contenu_markdown or "", s.index)
        if s.corrige_markdown:
            epreuve_files.write_document(db, e, "corrige", s.corrige_markdown, s.index)


def _relocate_files(db: Session, e: EpreuveORM) -> None:
    """Après un changement de niveau/classe/année, copie chaque fichier vers
    sa nouvelle clé canonique puis supprime l'ancien objet."""
    storage = epreuve_files.get_storage()
    for f in e.files_rel:
        if f.format == epreuve_files.DOCUMENT_FORMAT:
            new_key = epreuve_files.document_key(e, f.cible, f.sujet_index)
        else:
            # Relocalisation d'une image : retirer les préfixes `{cible}-`
            # répétés des clés héritées (corrigé 2026-09 — l'ancienne
            # version re-préfixait le basename déjà préfixé, produisant
            # `sujet-sujet-…` qui se dégradait à chaque déplacement) puis
            # reconstruire la clé canonique via image_key.
            basename = os.path.basename(f.storage_key)
            prefix = f"{f.cible}-"
            while basename.startswith(prefix):
                basename = basename[len(prefix):]
            new_key = epreuve_files.image_key(e, f.cible, basename)
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
def admin_publish(epreuve_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    """Publie une épreuve — exige au moins un document sujet (n'importe
    quel index) et au moins une série ; le corrigé n'est JAMAIS requis
    pour publier."""
    e = get_epreuve_or_404(db, epreuve_id)
    if not _has_any_sujet(db, epreuve_id):
        raise HTTPException(400, "Un sujet (document Markdown) est obligatoire pour publier")
    if not e.filieres:
        raise HTTPException(400, "Au moins une série est requise pour publier")
    e.statut = "publie"
    db.commit()
    log_admin_event(db, epreuve_id, "published", email=lock.email, details={"statut": "publie"})
    db.add(
        NotificationORM(
            titre="Nouvelle épreuve disponible",
            message=(
                f"{e.matiere or 'Sujet'} — {e.evaluation or ''} {e.annee or ''} ({e.classe or ''})"
            ).strip(),
            type="nouvelle_epreuve",
            epreuve_id=epreuve_id,
            actif=True,
        )
    )
    db.commit()
    return {"ok": True}


@router.post("/epreuves/{epreuve_id}/unpublish")
def admin_unpublish(epreuve_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    """Retire une épreuve du catalogue élève (repasse en "à réviser") sans
    la supprimer."""
    e = get_epreuve_or_404(db, epreuve_id)
    e.statut = "a_reviser"
    db.commit()
    log_admin_event(db, epreuve_id, "unpublished", email=lock.email, details={"statut": "a_reviser"})
    return {"ok": True}


@router.delete("/epreuves/{epreuve_id}")
def admin_delete_epreuve(epreuve_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    """Supprime définitivement une épreuve — les fichiers du stockage
    (documents + images) et les lignes liées partent avec elle."""
    e = get_epreuve_or_404(db, epreuve_id)
    # Capture AVANT suppression : le journal doit dire CE qui a été supprimé
    # (l'épreuve n'existe plus au moment de l'écriture de l'événement).
    meta = {"matiere": e.matiere, "classe": e.classe, "annee": e.annee, "evaluation": e.evaluation}
    # Tables référençant l'épreuve et SANS cascade ORM — à traiter à la main
    # avant la suppression, sinon la contrainte de clé étrangère la fait
    # échouer (liste exhaustive : subscriptions, ai_conversations, consultations,
    # notes, signalements ; filières et fichiers partent en cascade ORM) :
    # - les abonnements « épreuve précise » perdent leur cible (le paiement,
    #   lui, reste dans l'historique) ;
    # - l'historique de consultation et les discussions IA (élève ET
    #   back-office) de cette épreuve sont supprimés (plus de sens sans leur
    #   épreuve) ;
    # - les notes personnelles et signalements pointent sur l'épreuve (FK
    #   NOT NULL) : tout essai de suppression échouait sinon en 500 à la
    #   validation SQL, et leur contenu n'aurait plus de support.
    db.query(SubscriptionORM).filter(SubscriptionORM.epreuve_id == epreuve_id).update(
        {SubscriptionORM.epreuve_id: None}
    )
    db.query(AIConversationORM).filter(AIConversationORM.epreuve_id == epreuve_id).delete()
    db.query(AdminAIConversationORM).filter(AdminAIConversationORM.epreuve_id == epreuve_id).delete()
    db.query(ConsultationORM).filter(ConsultationORM.epreuve_id == epreuve_id).delete()
    db.query(NoteORM).filter(NoteORM.epreuve_id == epreuve_id).delete()
    db.query(SignalementORM).filter(SignalementORM.epreuve_id == epreuve_id).delete()
    # Les notifications liées perdent leur cible mais restent diffusées :
    # une notification sur une épreuve supprimée devient purement
    # informative (la cloche gère l'absence de lien en silence).
    db.query(NotificationORM).filter(NotificationORM.epreuve_id == epreuve_id).update(
        {NotificationORM.epreuve_id: None}
    )
    for f in list(e.files_rel):
        epreuve_files.delete_file(db, f)
    db.delete(e)  # cascade ORM : filières et fichiers restants supprimés avec l'épreuve
    db.commit()
    log_admin_event(db, epreuve_id, "deleted", email=lock.email, details=meta)
    log.info("Épreuve supprimée: %s", epreuve_id)
    return {"ok": True}


@router.post("/epreuves/{epreuve_id}/images")
def admin_upload_image(
    epreuve_id: str,
    file: UploadFile = File(...),
    cible: str = Form(...),
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Upload d'image d'illustration ciblée sujet/corrigé : valide le type
    MIME et la taille (5 Mo max), redimensionne à 1600px de large maximum
    et recompresse via Pillow (repli sur le fichier brut si Pillow échoue),
    puis enregistre le fichier dans le stockage objet + la table
    `epreuve_files`. Un avertissement est retourné si le même fichier
    (checksum) existe déjà sur une autre épreuve (détection de doublons).

    Route SYNCHRONE (def) : le traitement Pillow est CPU-bound, FastAPI
    l'exécute dans le threadpool — une route async gelait la boucle
    d'événements (donc toute l'API, streaming compris) pendant l'upload.
    La lecture est bornée (MAX+1 octets) : jamais plus de 5 Mo en RAM."""
    if cible not in ("sujet", "corrige"):
        raise HTTPException(400, "cible doit être 'sujet' ou 'corrige'")
    e = get_epreuve_or_404(db, epreuve_id)
    if file.content_type not in epreuve_files.ALLOWED_IMAGE_MIME:
        raise HTTPException(400, f"Type de fichier non autorisé: {file.content_type}")

    raw = _read_bounded(file, MAX_IMAGE_BYTES)

    try:
        data, mime, width, height = images.process_image(raw, file.content_type or "")
    except images.InvalidImageError as exc:
        raise HTTPException(415, f"Fichier image invalide : {exc}") from exc

    ext = os.path.splitext(file.filename or "")[1] or ".png"
    row = epreuve_files.save_image(
        db, e, cible, f"{uuid.uuid4().hex[:8]}{ext}", data, mime, width=width, height=height
    )
    db.commit()
    log_admin_event(
        db, epreuve_id, f"image_uploaded_{cible}", email=lock.email,
        details={"filename": row.filename, "size_bytes": row.size_bytes},
    )

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
        "url": signing.signed_file_url(row.id, row.epreuve_id, e.statut),
        "filename": row.filename,
        "cible": cible,
        "doublon_de": doublon.epreuve_id if doublon else None,
    }


@router.post("/epreuves/{epreuve_id}/documents")
def admin_upload_document(
    epreuve_id: str,
    file: UploadFile = File(...),
    cible: str = Form(...),
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Upload d'un DOCUMENT Markdown (.md) en remplacement du sujet ou du
    corrigé — même effet qu'un enregistrement via l'éditeur texte. (Le
    périmètre produit est Markdown uniquement : pas de PDF ni HTML.)
    Route SYNCHRONE + lecture bornée (voir `admin_upload_image`)."""
    if cible not in ("sujet", "corrige"):
        raise HTTPException(400, "cible doit être 'sujet' ou 'corrige'")
    e = get_epreuve_or_404(db, epreuve_id)
    name = (file.filename or "").lower()
    if not name.endswith(".md") and file.content_type not in ("text/markdown", "text/plain"):
        raise HTTPException(400, "Seuls les fichiers Markdown (.md) sont acceptés")

    raw = _read_bounded(file, MAX_DOCUMENT_BYTES)
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(400, "Le fichier doit être encodé en UTF-8") from exc

    row = epreuve_files.write_document(db, e, cible, content)
    db.commit()
    log_admin_event(
        db, epreuve_id, f"document_uploaded_{cible}", email=lock.email,
        details={"filename": file.filename or f"{cible}.md", "size": len(raw)},
    )
    return {"ok": True, "cible": cible, "size": len(raw), "cree": bool(row)}


@router.delete("/files/{file_id}")
def admin_delete_file(file_id: str, db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    """Supprime un fichier d'épreuve (objet du stockage + ligne en base)."""
    f = db.query(EpreuveFileORM).filter(EpreuveFileORM.id == file_id).one_or_none()
    if not f:
        raise HTTPException(404, "Fichier introuvable")
    epreuve_id = f.epreuve_id
    epreuve_files.delete_file(db, f)
    db.commit()
    log_admin_event(
        db, epreuve_id, f"file_deleted_{f.cible}", email=lock.email,
        details={"filename": f.filename, "file_id": file_id, "format": f.format},
    )
    return {"ok": True}
