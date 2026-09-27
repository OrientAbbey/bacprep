"""Helpers de gestion des fichiers d'épreuves (documents Markdown + images).

Centralise la construction des ``storage_key``, l'écriture/lecture des
documents sujet/corrigé et l'enregistrement des lignes ``epreuve_files``.
Le contenu lui-même vit dans le stockage objet (voir ``core/storage.py``) ;
la base ne garde que les métadonnées et la clé.
"""
from __future__ import annotations

import hashlib
import re
import uuid
from pathlib import Path
from typing import Optional

from sqlalchemy import event
from sqlalchemy.orm import Session

from ..db_models import EpreuveFileORM, EpreuveORM
from . import extraits
from .logging_config import get_logger
from .storage import get_storage

log = get_logger("epreuve_files")

DOCUMENT_FORMAT = "md"
IMAGE_FORMAT = "image"

# Clés d'objets devenus orphelins, accumulées dans ``db.info`` jusqu'au prochain
# commit RÉUSSI (voir ``_purge_orphans_after_commit``).
_ORPHANS_KEY = "epreuve_files.orphan_keys"


def _defer_object_deletion(db: Session, storage_key: str | None) -> None:
    """Programme la suppression d'un objet pour APRÈS le commit courant.

    Le stockage objet et la base ne partagent pas de transaction : supprimer
    l'objet avant le commit exposait une perte définitive. Si le commit
    échoue (contrainte, péremption de connexion), la transaction est annulée,
    la ligne conserve son ``storage_key`` — mais l'objet correspondant aurait
    déjà disparu, et l'épreuve affichait un document cassé jusqu'à une
    réécriture. L'ordre sûr est donc : écrire en base, valider, puis — et
    seulement si la validation a réussi — nettoyer le stockage.
    """
    if not storage_key:
        return
    orphans = db.info.get(_ORPHANS_KEY)
    if orphans is None:
        orphans = db.info[_ORPHANS_KEY] = []
    orphans.append(storage_key)


@event.listens_for(Session, "after_commit")
def _purge_orphans_after_commit(db: Session) -> None:
    """Supprime les objets dont la référence en base a été validée.

    Déclenché par SQLAlchemy après chaque ``commit()`` réussi, ce qui couvre
    tous les appelants de ``write_document`` / ``delete_file`` sans qu'ils
    aient à ordonnancer eux-mêmes la suppression.
    """
    for storage_key in db.info.pop(_ORPHANS_KEY, []):
        try:
            get_storage().delete(storage_key)
        except Exception as exc:
            # Fuite d'objet orphelin (coût de stockage, pas de perte de
            # donnée) : on ne fait pas échouer la requête déjà validée.
            log.warning("Suppression objet orphelin %s impossible: %s", storage_key, exc)


@event.listens_for(Session, "after_rollback")
def _forget_orphans_after_rollback(db: Session) -> None:
    """Abandonne les suppressions programmées quand la transaction est annulée.

    Sans ce nettoyage, la liste survit au rollback et le PROCHAIN commit réussi
    de cette même session purge les clés : la ligne ayant retrouvé son
    ``storage_key`` d'origine après l'annulation, on effaçait un objet encore
    référencé — un document cassé sur une épreuve qui, elle, n'avait jamais été
    modifiée. L'abandon provoque au pire une fuite d'objet, sans gravité ; la
    perte de référence, elle, n'en a pas.

    L'événement couvre aussi le rollback d'un SAVEPOINT : on perd alors peut-être
    une suppression qui aurait dû avoir lieu, ce qui reste une fuite d'objet.
    """
    db.info.pop(_ORPHANS_KEY, None)


# Source unique des MIME d'images acceptés à l'upload ET à l'import.
# Le SVG en est volontairement EXCLU : servi depuis l'origine de l'app, un
# SVG peut embarquer <script> (XSS stocké). Les quelques SVG pouvant exister
# dans d'anciennes données sont servis en `attachment` par routers/files.py.
ALLOWED_IMAGE_MIME = {"image/png", "image/jpeg", "image/webp", "image/gif"}


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _annee_key(epreuve: EpreuveORM) -> str:
    """Segment d'année d'une storage_key : "0000" (= à compléter, même
    convention que l'import) tant que l'année n'est pas renseignée."""
    return epreuve.annee or "0000"


def document_key(epreuve: EpreuveORM, cible: str, sujet_index: int = 0) -> str:
    """Clé du document Markdown d'une épreuve :
    ``epreuves/{niveau}/{annee}/{epreuve_id}/{cible}.md`` pour l'index 0
    (nom historique conservé), et
    ``epreuves/{niveau}/{annee}/{epreuve_id}/{cible}_{index}.md`` pour les
    indices supérieurs (sujets/corrigés supplémentaires)."""
    annee = _annee_key(epreuve)
    if sujet_index > 0:
        return f"epreuves/{epreuve.niveau}/{annee}/{epreuve.id}/{cible}_{sujet_index}.md"
    return f"epreuves/{epreuve.niveau}/{annee}/{epreuve.id}/{cible}.md"


def image_key(epreuve: EpreuveORM, cible: str, filename: str) -> str:
    """Clé d'une image d'illustration : ``epreuves/{niveau}/{annee}/{epreuve_id}/{cible}-{filename}``."""
    return f"epreuves/{epreuve.niveau}/{_annee_key(epreuve)}/{epreuve.id}/{cible}-{filename}"


def get_document(db: Session, epreuve_id: str, cible: str, sujet_index: int = 0) -> Optional[EpreuveFileORM]:
    """Ligne du document Markdown (sujet ou corrigé) d'une épreuve et d'un
    sujet donné (index 0 par défaut), ou None."""
    return (
        db.query(EpreuveFileORM)
        .filter(
            EpreuveFileORM.epreuve_id == epreuve_id,
            EpreuveFileORM.cible == cible,
            EpreuveFileORM.format == DOCUMENT_FORMAT,
            EpreuveFileORM.sujet_index == sujet_index,
        )
        .one_or_none()
    )


def read_document_content(db: Session, epreuve_id: str, cible: str, sujet_index: int = 0) -> str:
    """Contenu Markdown d'un document chargé depuis le stockage ('' si absent)."""
    doc = get_document(db, epreuve_id, cible, sujet_index)
    if not doc:
        return ""
    try:
        return get_storage().get_bytes(doc.storage_key).decode("utf-8")
    except Exception as exc:
        log.error("Lecture impossible du document %s (%s/%s): %s", epreuve_id, cible, sujet_index, exc)
        return ""


def write_document(
    db: Session, epreuve: EpreuveORM, cible: str, content: str, sujet_index: int = 0
) -> Optional[EpreuveFileORM]:
    """Écrit (ou remplace) le document Markdown d'une cible et d'un sujet
    dans le stockage.

    Un contenu vide supprime le document (la présence de la ligne ⇔ contenu
    non vide, ce qui rend ``corrige_disponible`` fiable sans lire l'objet).
    """
    if cible not in ("sujet", "corrige"):
        raise ValueError(f"cible invalide: {cible}")
    if sujet_index < 0:
        raise ValueError("sujet_index invalide (>= 0 attendu)")

    existing = get_document(db, epreuve.id, cible, sujet_index)
    stripped = (content or "").strip()
    if not stripped:
        if existing:
            delete_file(db, existing)
        return None

    data = stripped.encode("utf-8")
    key = document_key(epreuve, cible, sujet_index)
    get_storage().put_bytes(key, data, "text/markdown; charset=utf-8")

    # Extrait de présentation : régénéré à chaque écriture du SUJET
    # PRINCIPAL (index 0) — le corrigé et les sujets supplémentaires ne
    # portent pas l'extrait — alimente les cartes du catalogue.
    if cible == "sujet" and sujet_index == 0:
        epreuve.extrait = extraits.build_extrait(stripped)
        db.add(epreuve)

    filename = f"{cible}.md" if sujet_index == 0 else f"{cible}_{sujet_index}.md"
    if existing:
        old_key = existing.storage_key
        existing.filename = filename
        existing.storage_key = key
        existing.mime_type = "text/markdown; charset=utf-8"
        existing.size_bytes = len(data)
        existing.checksum_sha256 = sha256_hex(data)
        db.add(existing)
        if old_key != key:
            # `document_key` dépend du NIVEAU et de l'ANNÉE (pas de la classe) :
            # les modifier change la clé et laisse l'ancien objet orphelin dans
            # le bucket. Sa suppression est DIFFÉRÉE jusqu'au commit (cf.
            # _defer_object_deletion) — l'effacer ici laisserait un document
            # cassé si le commit échouait.
            _defer_object_deletion(db, old_key)
        return existing

    row = EpreuveFileORM(
        epreuve_id=epreuve.id,
        cible=cible,
        format=DOCUMENT_FORMAT,
        sujet_index=sujet_index,
        filename=filename,
        storage_key=key,
        mime_type="text/markdown; charset=utf-8",
        size_bytes=len(data),
        checksum_sha256=sha256_hex(data),
    )
    db.add(row)
    db.flush()
    return row


def save_image(
    db: Session,
    epreuve: EpreuveORM,
    cible: str,
    filename: str,
    data: bytes,
    mime_type: str,
    width: int | None = None,
    height: int | None = None,
) -> EpreuveFileORM:
    """Enregistre une image d'illustration (déjà optimisée par l'appelant)
    dans le stockage et en base — dimensions en pixels si mesurées."""
    filename = Path(filename or "image.png").name or "image.png"
    key = image_key(epreuve, cible, f"{uuid.uuid4().hex[:8]}-{filename}")
    get_storage().put_bytes(key, data, mime_type)
    row = EpreuveFileORM(
        epreuve_id=epreuve.id,
        cible=cible,
        format=IMAGE_FORMAT,
        filename=filename,
        storage_key=key,
        mime_type=mime_type,
        size_bytes=len(data),
        width=width,
        height=height,
        checksum_sha256=sha256_hex(data),
    )
    db.add(row)
    db.flush()
    return row


def delete_file(db: Session, row: EpreuveFileORM) -> None:
    """Supprime un fichier : la ligne d'abord, l'objet APRÈS le commit.

    L'inverse (objet d'abord) exposait la perte définitive : un commit en
    échec laissait la ligne pointer vers un objet déjà effacé. Une fuite
    d'objet orphelin si la suppression échoue est sans gravité ; une référence
    cassée ne l'est pas. La suppression est donc programmée par
    ``_defer_object_deletion`` et exécutée par ``after_commit``.
    """
    _defer_object_deletion(db, row.storage_key)
    db.delete(row)


_IMAGE_MD_RE = extraits.IMAGE_MD_RE


def file_id_from_url(url: str) -> str | None:
    """Extrait l'identifiant d'un fichier depuis une URL ``/api/files/{id}``
    (la suite du chemin, une query string éventuelle — URL signée — et un
    fragment ``#w=NNN`` de taille d'affichage sont ignorés). None si l'URL
    ne pointe pas vers /api/files/."""
    marker = "/api/files/"
    if marker not in url:
        return None
    file_id = url.split(marker, 1)[1].split("/")[0].split("?")[0].split("#")[0]
    return file_id or None


def sign_image_urls(markdown: str, epreuve: EpreuveORM) -> str:
    """Réécrit les références ``![...](/api/files/{id})`` d'un Markdown en
    ajoutant un jeton d'accès court lié à l'épreuve et à son statut courant
    (les balises ``<img>`` générées par le lecteur ne transportent pas le
    cookie de session en cross-origin, le jeton remplace donc la session pour
    ces requêtes — voir `core/signing.py`).

    Le fragment ``#w=NNN`` (taille d'affichage de l'image, chantier
    « images redimensionnables ») est PRÉSERVÉ : il est ré-accolé après
    l'URL signée pour que le lecteur continue d'appliquer la largeur
    demandée (sans lui, la taille disparaîtrait à l'envoi)."""
    from .signing import signed_file_url

    def _replace(match: re.Match) -> str:
        alt, url = match.group(1), match.group(2)
        file_id = file_id_from_url(url)
        if not file_id:
            return match.group(0)
        fragment = ""
        if "#" in url:
            fragment = "#" + url.split("#", 1)[1]
        return f"![{alt}]({signed_file_url(file_id, epreuve.id, epreuve.statut)}{fragment})"

    return _IMAGE_MD_RE.sub(_replace, markdown or "")
