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

from sqlalchemy.orm import Session

from ..db_models import EpreuveFileORM, EpreuveORM
from .logging_config import get_logger
from .storage import get_storage

log = get_logger("epreuve_files")

DOCUMENT_FORMAT = "md"
IMAGE_FORMAT = "image"

ALLOWED_IMAGE_MIME = {"image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"}


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def document_key(epreuve: EpreuveORM, cible: str) -> str:
    """Clé du document Markdown d'une épreuve :
    ``epreuves/{niveau}/{annee}/{epreuve_id}/{cible}.md``."""
    return f"epreuves/{epreuve.niveau}/{epreuve.annee}/{epreuve.id}/{cible}.md"


def image_key(epreuve: EpreuveORM, cible: str, filename: str) -> str:
    """Clé d'une image d'illustration : ``epreuves/{niveau}/{annee}/{epreuve_id}/{cible}-{filename}``."""
    return f"epreuves/{epreuve.niveau}/{epreuve.annee}/{epreuve.id}/{cible}-{filename}"


def new_epreuve_id(db: Session) -> str:
    """Identifiant court unique pour une nouvelle épreuve (ex. ``8f3a2c91``)."""
    while True:
        candidate = uuid.uuid4().hex[:8]
        if not db.query(EpreuveORM).filter(EpreuveORM.id == candidate).one_or_none():
            return candidate


def get_document(db: Session, epreuve_id: str, cible: str) -> Optional[EpreuveFileORM]:
    """Ligne du document Markdown (sujet ou corrigé) d'une épreuve, ou None."""
    return (
        db.query(EpreuveFileORM)
        .filter(
            EpreuveFileORM.epreuve_id == epreuve_id,
            EpreuveFileORM.cible == cible,
            EpreuveFileORM.format == DOCUMENT_FORMAT,
        )
        .one_or_none()
    )


def read_document_content(db: Session, epreuve_id: str, cible: str) -> str:
    """Contenu Markdown d'un document chargé depuis le stockage ('' si absent)."""
    doc = get_document(db, epreuve_id, cible)
    if not doc:
        return ""
    try:
        return get_storage().get_bytes(doc.storage_key).decode("utf-8")
    except Exception as exc:
        log.error("Lecture impossible du document %s (%s): %s", epreuve_id, cible, exc)
        return ""


def write_document(
    db: Session, epreuve: EpreuveORM, cible: str, content: str
) -> Optional[EpreuveFileORM]:
    """Écrit (ou remplace) le document Markdown d'une cible dans le stockage.

    Un contenu vide supprime le document (la présence de la ligne ⇔ contenu
    non vide, ce qui rend ``corrige_disponible`` fiable sans lire l'objet).
    """
    if cible not in ("sujet", "corrige"):
        raise ValueError(f"cible invalide: {cible}")

    existing = get_document(db, epreuve.id, cible)
    stripped = (content or "").strip()
    if not stripped:
        if existing:
            delete_file(db, existing)
        return None

    data = stripped.encode("utf-8")
    key = document_key(epreuve, cible)
    get_storage().put_bytes(key, data, "text/markdown; charset=utf-8")

    if existing:
        existing.filename = f"{cible}.md"
        existing.storage_key = key
        existing.mime_type = "text/markdown; charset=utf-8"
        existing.size_bytes = len(data)
        existing.checksum_sha256 = sha256_hex(data)
        db.add(existing)
        return existing

    row = EpreuveFileORM(
        epreuve_id=epreuve.id,
        cible=cible,
        format=DOCUMENT_FORMAT,
        filename=f"{cible}.md",
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
) -> EpreuveFileORM:
    """Enregistre une image d'illustration (déjà optimisée par l'appelant)
    dans le stockage et en base."""
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
        checksum_sha256=sha256_hex(data),
    )
    db.add(row)
    db.flush()
    return row


def delete_file(db: Session, row: EpreuveFileORM) -> None:
    """Supprime un fichier : objet du stockage PUIS ligne en base (l'inverse
    exposerait une clé pointant vers un objet fantôme)."""
    try:
        get_storage().delete(row.storage_key)
    except Exception as exc:
        log.warning("Suppression objet %s impossible (ligne supprimée quand même): %s", row.storage_key, exc)
    db.delete(row)


_IMAGE_MD_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")


def find_file_id_refs(markdown: str) -> list[str]:
    """Extrait les identifiants de fichiers référencés dans un Markdown sous
    la forme ``![légende](/api/files/{id})`` — utilisé par l'import massif
    et l'assistant (pièces jointes multimodales)."""
    ids: list[str] = []
    for url in _IMAGE_MD_RE.findall(markdown or ""):
        marker = "/api/files/"
        if marker not in url:
            continue
        file_id = url.split(marker, 1)[1].split("/")[0].split("?")[0]
        if file_id:
            ids.append(file_id)
    return ids


def sign_image_urls(markdown: str) -> str:
    """Réécrit les références ``![...](/api/files/{id})`` d'un Markdown en
    ajoutant un jeton d'accès court : les balises ``<img>`` générées par le
    lecteur ne transportent pas le cookie de session (requêtes cross-origin
    en développement), le jeton remplace donc la session pour ces requêtes
    — voir `core/signing.py`."""
    from .signing import signed_file_url

    def _replace(match: re.Match) -> str:
        alt, url = match.group(1), match.group(2)
        marker = "/api/files/"
        if marker not in url:
            return match.group(0)
        file_id = url.split(marker, 1)[1].split("/")[0].split("?")[0]
        if not file_id:
            return match.group(0)
        return f"![{alt}]({signed_file_url(file_id)})"

    return _IMAGE_MD_RE.sub(_replace, markdown or "")
