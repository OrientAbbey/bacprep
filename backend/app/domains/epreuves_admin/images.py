"""Traitement d'images à l'upload admin (logique métier, hors router).

Validation du contenu réel (magic bytes via Pillow) + redimensionnement +
recompression. Isolé ici pour rester testable unitairement sans FastAPI ni
base.

Sécurité : la vérification se fait sur le CONTENU décodé par Pillow, pas
sur le Content-Type déclaré par le client (forgeable). Un fichier qui
n'est pas une image décodable lève une exception — l'appelant répond 415 ;
on ne retombe JAMAIS sur le stockage des octets bruts avec le MIME
déclaré (un HTML/JS déguisé en PNG serait alors servi depuis l'origine de
l'app).
"""
from __future__ import annotations

import os
from io import BytesIO
from typing import Optional

from ...core.logging_config import get_logger

log = get_logger("images")

try:
    from PIL import Image
    _PILLOW_OK = True
except Exception:  # pragma: no cover
    _PILLOW_OK = False

MAX_IMAGE_WIDTH = 1600

# Plafond d'un upload d'illustration, partagé par les endpoints Épreuves et Banque.
MAX_IMAGE_BYTES = 5 * 1024 * 1024

# Garde-fou anti "decompression bomb" explicite (Pillow en a un par défaut,
# ~178 Mpx, mais on le fixe ici pour ne pas dépendre de sa valeur ni de
# son évolution : 30 Mpx dépassent largement une photo scannée d'épreuve).
MAX_IMAGE_PIXELS = 30_000_000

# Formats réellement décodés et réencodés — alignés sur ALLOWED_IMAGE_MIME
# (core/epreuve_files.py). Le SVG en est exclu (XSS stocké possible).
ALLOWED_IMAGE_FORMATS = {"PNG", "JPEG", "WEBP", "GIF"}

if _PILLOW_OK:
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


class InvalidImageError(ValueError):
    """Le contenu fourni n'est pas une image valide ou d'un format
    autorisé — le routeur répondra 415."""


class UploadImageError(ValueError):
    """Rejet d'un upload d'image : ``code`` vaut ``"type"`` (400),
    ``"taille"`` (413) ou ``"contenu"`` (415) pour le mapping HTTP."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code

    @property
    def http_status(self) -> int:
        """Statut HTTP correspondant au motif de rejet."""
        # 400 pour la taille : c'est le statut historique de l'upload d'image
        # d'épreuve, conservé pour ne pas casser les clients existants.
        return {"type": 400, "taille": 400, "contenu": 415}[self.code]


def validate_upload_image(upload) -> tuple[bytes, str, Optional[int], Optional[int], str]:
    """Valide et optimise une illustration uploadée, une seule fois pour tous
    les endpoints (Épreuves et Banque).

    ``upload`` est un objet ``UploadFile`` (duck-typé : ``content_type``,
    ``filename`` et ``file.read``). Retourne ``(données, MIME, largeur,
    hauteur, extension)``. Lève ``UploadImageError`` avec un code qui permet
    au routeur de répondre 400 (type ou taille) ou 415 (contenu).
    """
    from .epreuve_files import ALLOWED_IMAGE_MIME

    type_declare = getattr(upload, "content_type", None)
    if type_declare not in ALLOWED_IMAGE_MIME:
        raise UploadImageError("type", f"Type de fichier non autorisé: {type_declare}")
    brut = upload.file.read(MAX_IMAGE_BYTES + 1)
    if len(brut) > MAX_IMAGE_BYTES:
        raise UploadImageError("taille", "Image trop volumineuse (5 Mo maximum)")
    try:
        donnees, mime, largeur, hauteur = process_image(brut, type_declare or "")
    except InvalidImageError as exc:
        raise UploadImageError("contenu", f"Fichier image invalide : {exc}") from exc
    ext = os.path.splitext(getattr(upload, "filename", "") or "")[1] or ".png"
    return donnees, mime, largeur, hauteur, ext


AVATAR_TAILLE = 256


def process_avatar(raw: bytes) -> bytes:
    """Image envoyée pour l'avatar → WebP carré de 256 px, orientation EXIF appliquée puis
    métadonnées (GPS, appareil…) supprimées par le ré-encodage. Même validation du CONTENU que
    `process_image` ; lève `InvalidImageError` si ce n'est pas une image d'un format autorisé."""
    process_image(raw, "image/png")  # valide magic bytes, format et taille ; l'image redimensionnée est ignorée
    from PIL import ImageOps

    try:
        img = ImageOps.exif_transpose(Image.open(BytesIO(raw)))
        img = ImageOps.fit(img.convert("RGBA"), (AVATAR_TAILLE, AVATAR_TAILLE), Image.Resampling.LANCZOS)
        sortie = BytesIO()
        img.save(sortie, format="WEBP", quality=82, method=6)
        return sortie.getvalue()
    except Exception as exc:
        raise InvalidImageError(f"traitement de l'avatar impossible : {exc}") from exc


def process_image(raw: bytes, mime: str) -> tuple[bytes, str, Optional[int], Optional[int]]:
    """Valide puis optimise une image uploadée : format vérifié via les
    magic bytes (décodage Pillow), dimensions mesurées, réduction à
    ``MAX_IMAGE_WIDTH`` de large max, recompression. Retourne
    ``(data, mime, width, height)``.

    Lève ``InvalidImageError`` si le contenu n'est pas une image décodable
    d'un format autorisé. Si Pillow est totalement indisponible
    (installation dégradée), le fichier brut est retourné tel quel — le
    filtrage par Content-Type côté routeur reste alors la seule barrière.
    """
    if not _PILLOW_OK:  # pragma: no cover
        log.warning("Pillow indisponible — image stockée brute sans vérification du contenu")
        return raw, mime, None, None

    try:
        probe = Image.open(BytesIO(raw))
        probe.verify()  # vérifie intégrité + consomme l'objet ; fixe .format
        fmt = (probe.format or "").upper()
    except Exception as exc:
        raise InvalidImageError(f"contenu non décodable comme image : {exc}") from exc
    if fmt not in ALLOWED_IMAGE_FORMATS:
        raise InvalidImageError(f"format d'image non autorisé : {fmt or 'inconnu'}")

    try:
        img = Image.open(BytesIO(raw))
        width, height = img.width, img.height
        if img.width > MAX_IMAGE_WIDTH:
            ratio = MAX_IMAGE_WIDTH / img.width
            img = img.resize((MAX_IMAGE_WIDTH, int(img.height * ratio)))
            width, height = img.width, img.height
        buf = BytesIO()
        # format explicite : vers un BytesIO, Pillow ne peut pas le déduire
        # d'une extension (Pillow >= 10 lève sinon "unknown file extension").
        img.save(buf, format=fmt, optimize=True)
        data = buf.getvalue()
        out_mime = Image.MIME.get(fmt, mime)
        return data, out_mime, width, height
    except Exception as exc:
        raise InvalidImageError(f"traitement de l'image impossible : {exc}") from exc
