"""Service de stockage objet pour les fichiers d'épreuves (Markdown + images).

La base de données ne conserve que les métadonnées et la ``storage_key`` de
chaque fichier (ex. ``epreuves/SECONDAIRE/2023/8f3a2c91/sujet.md``) — JAMAIS
le contenu. L'arborescence physique ne reflète que (niveau, année, épreuve) :
toute la classification métier (classe, évaluation, matière, séries) vit en
base, pas dans les dossiers.

Deux backends, choisis par ``STORAGE_BACKEND`` :

- ``local`` (développement) : la clé devient un chemin relatif sous
  ``backend/data/storage/`` — sémantique identique à un stockage objet, ce
  qui permet de développer sans compte Cloudflare ;
- ``r2`` (production) : Cloudflare R2 via l'API S3 compatible (boto3), avec
  URL signées temporaires pour servir les fichiers privés sans exposer les
  identifiants du bucket.

Le filesystem local du serveur FastAPI n'est PAS un stockage persistant en
production ; seul le backend ``r2`` l'est (voir architecture technique).
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, Protocol

from .logging_config import get_logger

log = get_logger("storage")


class StorageError(RuntimeError):
    """Erreur de stockage (clé invalide, objet introuvable à l'écriture...)."""


def normalize_key(key: str) -> str:
    """Valide et normalise une storage_key : chemin POSIX relatif, sans
    composant ``..`` ni segment vide (garde-fou anti path-traversal pour le
    backend local, où la clé devient un chemin disque)."""
    key = (key or "").strip().replace("\\", "/")
    if not key or key.startswith("/") or ".." in key.split("/"):
        raise StorageError(f"Clé de stockage invalide: {key!r}")
    segments = [s for s in key.split("/") if s]
    if not segments:
        raise StorageError(f"Clé de stockage invalide: {key!r}")
    return "/".join(segments)


class StorageService(Protocol):
    """Interface commune aux backends de stockage."""

    backend: str

    def put_bytes(self, key: str, data: bytes, mime_type: str = "") -> None: ...

    def get_bytes(self, key: str) -> bytes: ...

    def delete(self, key: str) -> None: ...

    def exists(self, key: str) -> bool: ...

    def presigned_url(self, key: str, expires_seconds: int = 900) -> Optional[str]:
        """URL d'accès temporaire, ou None si le backend n'en produit pas
        (backend local : l'accès passe par le streaming FastAPI)."""
        ...


class LocalStorage:
    """Stockage développement : fichiers sous STORAGE_LOCAL_DIR, la clé
    étant un chemin relatif — miroir local de la sémantique objet."""

    backend = "local"

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        path = (self.root / normalize_key(key)).resolve()
        # Double garde après resolve() : la clé ne doit jamais sortir de la racine.
        path.relative_to(self.root)
        return path

    def put_bytes(self, key: str, data: bytes, mime_type: str = "") -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def get_bytes(self, key: str) -> bytes:
        path = self._path(key)
        if not path.is_file():
            raise StorageError(f"Objet introuvable: {key}")
        return path.read_bytes()

    def delete(self, key: str) -> None:
        path = self._path(key)
        if path.is_file():
            path.unlink()
            # Nettoie les dossiers parents devenus vides (évite l'accumulation
            # de répertoires vides à force de remplacements/suppressions).
            parent = path.parent
            while parent != self.root and not any(parent.iterdir()):
                parent.rmdir()
                parent = parent.parent

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def presigned_url(self, key: str, expires_seconds: int = 900) -> Optional[str]:
        return None

    def local_path(self, key: str) -> Optional[Path]:
        """Chemin disque d'une clé, pour le streaming FastAPI (backend
        local uniquement)."""
        path = self._path(key)
        return path if path.is_file() else None


class R2Storage:
    """Stockage production : Cloudflare R2 via l'API S3 (boto3).

    Les URL signées permettent de servir un fichier privé pendant une durée
    limitée sans exposer les identifiants du bucket — la vérification des
    droits reste du côté FastAPI (voir GET /api/files/{id}).
    """

    backend = "r2"

    def __init__(
        self,
        account_id: str,
        access_key_id: str,
        secret_access_key: str,
        bucket: str,
    ):
        import boto3  # import tardif : inutile en développement local

        self.bucket = bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name="auto",
        )

    def put_bytes(self, key: str, data: bytes, mime_type: str = "") -> None:
        extra = {"ContentType": mime_type} if mime_type else {}
        self._client.put_object(Bucket=self.bucket, Key=normalize_key(key), Body=data, **extra)

    def get_bytes(self, key: str) -> bytes:
        resp = self._client.get_object(Bucket=self.bucket, Key=normalize_key(key))
        return resp["Body"].read()

    def delete(self, key: str) -> None:
        self._client.delete_object(Bucket=self.bucket, Key=normalize_key(key))

    def exists(self, key: str) -> bool:
        import botocore.exceptions

        try:
            self._client.head_object(Bucket=self.bucket, Key=normalize_key(key))
            return True
        except botocore.exceptions.ClientError:
            return False

    def presigned_url(self, key: str, expires_seconds: int = 900) -> Optional[str]:
        return self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": normalize_key(key)},
            ExpiresIn=expires_seconds,
        )


_storage: Optional[StorageService] = None


def get_storage() -> StorageService:
    """Fabrique singleton du backend de stockage (STORAGE_BACKEND=local|r2)."""
    global _storage
    if _storage is not None:
        return _storage

    backend = os.getenv("STORAGE_BACKEND", "local").strip().lower()
    if backend == "r2":
        account_id = os.getenv("R2_ACCOUNT_ID", "")
        access_key = os.getenv("R2_ACCESS_KEY_ID", "")
        secret_key = os.getenv("R2_SECRET_ACCESS_KEY", "")
        bucket = os.getenv("R2_BUCKET", "")
        if not all([account_id, access_key, secret_key, bucket]):
            raise StorageError(
                "STORAGE_BACKEND=r2 exige R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, "
                "R2_SECRET_ACCESS_KEY et R2_BUCKET dans l'environnement"
            )
        _storage = R2Storage(account_id, access_key, secret_key, bucket)
    else:
        from ..db import STORAGE_LOCAL_DIR

        _storage = LocalStorage(STORAGE_LOCAL_DIR)

    log.info("Backend de stockage actif: %s", _storage.backend)
    return _storage


def presigned_url_or_none(key: str, expires_seconds: Optional[int] = None) -> Optional[str]:
    """URL signée si le backend actif en produit (r2), sinon None —
    l'appelant retombe alors sur le streaming FastAPI."""
    if expires_seconds is None:
        expires_seconds = int(os.getenv("R2_SIGNED_URL_EXPIRY", "900"))
    try:
        return get_storage().presigned_url(key, expires_seconds)
    except Exception as exc:  # jamais bloquant : le streaming reste possible
        log.warning("Génération d'URL signée impossible pour %s: %s", key, exc)
        return None
