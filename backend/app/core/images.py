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

from io import BytesIO
from typing import Optional

from .logging_config import get_logger

log = get_logger("images")

try:
    from PIL import Image
    _PILLOW_OK = True
except Exception:  # pragma: no cover
    _PILLOW_OK = False

MAX_IMAGE_WIDTH = 1600

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
