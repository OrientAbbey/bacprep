"""Signatures d'URL pour l'accès contrôlé aux fichiers d'épreuves.

Les images insérées dans le Markdown sont chargées par des balises
``<img>`` : selon le contexte (cross-origin en développement, intégration
dans une vue), ces requêtes ne transportent pas toujours le cookie de
session. Chaque référence de fichier est donc servie avec un jeton HMAC
court (comme les presigned URLs de R2, version maison pour le backend) :
``GET /api/files/{id}?token=...`` est accepté sans session tant que le
jeton est valide et récent — la vérification des droits proprement dite
reste faite à la génération de l'URL (détail d'épreuve).
"""
from __future__ import annotations

import hashlib
import hmac
import os
import time

DEFAULT_MAX_AGE_SECONDS = 24 * 3600  # durée de lecture largement suffisante


def _secret() -> bytes:
    """Clé HMAC : FILE_URL_SECRET si fournie, sinon dérivée du jeton admin
    (prototype : une seule instance, la cohérence entre serveurs n'est pas
    un besoin tant qu'il n'y a pas de réplique backend)."""
    raw = os.getenv("FILE_URL_SECRET") or os.getenv("ADMIN_TOKEN") or "bacprep-dev-secret"
    return raw.encode("utf-8")


def sign_file_id(file_id: str, max_age_seconds: int = DEFAULT_MAX_AGE_SECONDS) -> tuple[str, int]:
    """Retourne ``(token, expires_at_epoch)`` pour un identifiant de fichier."""
    expires = int(time.time()) + max_age_seconds
    msg = f"{file_id}.{expires}".encode("utf-8")
    digest = hmac.new(_secret(), msg, hashlib.sha256).hexdigest()
    return f"{expires}.{digest}", expires


def verify_file_token(file_id: str, token: str, max_age_grace: int = 3600) -> bool:
    """Vérifie un jeton émis par `sign_file_id`. Une petite tolérance
    (grâce d'une heure) accepte les jetons expirés depuis peu : le jeton
    n'est qu'un accélérateur d'accès, les droits ayant déjà été vérifiés à
    son émission — on évite simplement qu'une image casse en pleine lecture
    d'une épreuve ouverte depuis un moment."""
    try:
        expires_raw, digest = token.split(".", 1)
        expires = int(expires_raw)
    except (ValueError, AttributeError):
        return False
    msg = f"{file_id}.{expires}".encode("utf-8")
    expected = hmac.new(_secret(), msg, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, digest):
        return False
    return int(time.time()) <= expires + max_age_grace


def signed_file_url(file_id: str, max_age_seconds: int = DEFAULT_MAX_AGE_SECONDS) -> str:
    """URL d'accès contrôlé complète : ``/api/files/{id}?token=...``."""
    token, _ = sign_file_id(file_id, max_age_seconds)
    return f"/api/files/{file_id}?token={token}"
