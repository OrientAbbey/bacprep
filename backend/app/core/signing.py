"""Signatures d'URL pour l'accès contrôlé aux fichiers d'épreuves.

Les images insérées dans le Markdown sont chargées par des balises
``<img>`` : selon le contexte (cross-origin en développement, intégration
dans une vue), ces requêtes ne transportent pas toujours le cookie de
session. Chaque référence de fichier est donc servie avec un jeton HMAC
court (comme les presigned URLs S3, version maison pour le backend) :
``GET /api/files/{id}?token=...`` est accepté sans session tant que le
jeton est valide et récent — la vérification des droits proprement dite
reste faite à la génération de l'URL (détail d'épreuve).

Revue sécurité 2026-09 : le jeton signe désormais ``file_id + epreuve_id +
statut`` (et non plus ``file_id`` seul) — une URL générée alors que
l'épreuve était publiée est IMMÉDIATEMENT invalidée si l'épreuve est
retirée (ou brouillon) : la dépublication révoque les URLs déjà répandues,
au lieu de les laisser valables jusqu'à expiration.

Les URLs sont régénérées à chaque chargement du détail d'épreuve et à
chaque upload admin : la durée de vie peut donc rester courte (1 h).
"""
from __future__ import annotations

import hashlib
import hmac
import os
import time

DEFAULT_MAX_AGE_SECONDS = 3600  # régénérées à chaque affichage du détail
GRACE_SECONDS = 300  # tolérance : image qui casse en pleine lecture d'une page ouverte


def _secret() -> bytes:
    """Clé HMAC : ``FILE_URL_SECRET`` si fournie, sinon ``ADMIN_TOKEN``
    hors production. Aucun repli codé en dur — sans secret configuré, on
    refuse de signer (une clé dev-secret partagée permettrait de forger
    des jetons hors ligne). En production (ENV=prod), le fallback sur
    ADMIN_TOKEN est refusé : un secret dédié devient obligatoire, pour
    qu'une rotation du jeton admin n'invalide pas les URLs signées et
    qu'un jeton faible n'affaiblisse pas la signature des fichiers."""
    from .config import is_prod

    raw = os.getenv("FILE_URL_SECRET")
    if not raw and is_prod():
        raise RuntimeError(
            "FILE_URL_SECRET est obligatoire en production (le repli sur ADMIN_TOKEN y est refusé)"
        )
    raw = raw or os.getenv("ADMIN_TOKEN")
    if not raw:
        raise RuntimeError(
            "FILE_URL_SECRET (ou ADMIN_TOKEN) doit être configuré pour signer les URLs de fichiers"
        )
    return raw.encode("utf-8")


def sign_file_id(
    file_id: str,
    epreuve_id: str = "",
    statut: str = "",
    max_age_seconds: int = DEFAULT_MAX_AGE_SECONDS,
) -> tuple[str, int]:
    """Retourne ``(token, expires_at_epoch)`` pour un fichier, lié à son
    épreuve et à son statut courant — un changement d'un des trois éléments
    invalide le jeton (voir le docstring de module)."""
    expires = int(time.time()) + max_age_seconds
    msg = f"{epreuve_id}.{statut}.{file_id}.{expires}".encode("utf-8")
    digest = hmac.new(_secret(), msg, hashlib.sha256).hexdigest()
    return f"{expires}.{digest}", expires


def verify_file_token(
    file_id: str,
    epreuve_id: str,
    statut: str,
    token: str,
    max_age_grace: int = GRACE_SECONDS,
) -> bool:
    """Vérifie un jeton émis par `sign_file_id` contre le fichier/l'épreuve/
    statut COURANTS. Une petite tolérance accepte les jetons expirés depuis
    peu : le jeton n'est qu'un accélérateur d'accès, les droits ayant déjà
    été vérifiés à son émission — on évite simplement qu'une image casse en
    pleine lecture d'une épreuve ouverte depuis un moment."""
    try:
        expires_raw, digest = token.split(".", 1)
        expires = int(expires_raw)
    except (ValueError, AttributeError):
        return False
    msg = f"{epreuve_id}.{statut}.{file_id}.{expires}".encode("utf-8")
    expected = hmac.new(_secret(), msg, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, digest):
        return False
    return int(time.time()) <= expires + max_age_grace


def signed_file_url(
    file_id: str,
    epreuve_id: str = "",
    statut: str = "",
    max_age_seconds: int = DEFAULT_MAX_AGE_SECONDS,
) -> str:
    """URL d'accès contrôlé complète : ``/api/files/{id}?token=...``."""
    token, _ = sign_file_id(file_id, epreuve_id, statut, max_age_seconds)
    return f"/api/files/{file_id}?token={token}"
