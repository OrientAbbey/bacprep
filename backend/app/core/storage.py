"""Service de stockage objet pour les fichiers d'épreuves (Markdown + images).

La base de données ne conserve que les métadonnées et la ``storage_key`` de
chaque fichier (ex. ``epreuves/SECONDAIRE/2023/8f3a2c91/sujet.md``) — JAMAIS
le contenu. L'arborescence physique ne reflète que (niveau, année, épreuve) :
toute la classification métier (classe, évaluation, matière, séries) vit en
base, pas dans les dossiers.

Backends, choisis par ``STORAGE_BACKEND`` :

- ``local`` (développement) : la clé devient un chemin relatif sous
  ``backend/data/storage/`` — sémantique identique à un stockage objet, ce
  qui permet de développer sans compte cloud ;
- ``s3`` (production) : stockage objet S3-compatible via boto3, paramétré
  par les variables ``STORAGE_*`` (endpoint, région, clés, bucket). Un seul
  client S3 sert indifféremment Supabase Storage, Tigris Data et Backblaze
  B2 — le choix du fournisseur ne change que la valeur des variables.

Le filesystem local du serveur FastAPI n'est PAS un stockage persistant en
production ; seul un backend objet (``s3``) l'est. Les fichiers privés
sont servis via des URL signées temporaires (``presigned_url``) afin de ne
jamais exposer les identifiants du bucket.
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

    def presigned_url(self, key: str, expires_seconds: int = 900, content_disposition: Optional[str] = None) -> Optional[str]:
        """URL d'accès temporaire, ou None si le backend n'en produit pas
        (backend local : l'accès passe par le streaming FastAPI).

        ``content_disposition`` (``"attachment"``) force le téléchargement
        côté navigateur au lieu du rendu inline — nécessaire pour les types
        actifs comme SVG. Le paramètre ``ResponseContentDisposition`` est
        pris en charge par ``get_object``.
        """
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

    def presigned_url(self, key: str, expires_seconds: int = 900, content_disposition: Optional[str] = None) -> Optional[str]:
        return None

    def local_path(self, key: str) -> Optional[Path]:
        """Chemin disque d'une clé, pour le streaming FastAPI (backend
        local uniquement)."""
        path = self._path(key)
        return path if path.is_file() else None


class S3CompatibleStorage:
    """Stockage production : n'importe quel fournisseur S3-compatible (boto3).

    Le même code sert Supabase Storage, Tigris Data et Backblaze B2 — seule
    la configuration (endpoint, région, clés, bucket) change. Le bucket doit
    exister (créé côté fournisseur, en accès PRIVÉ).

    Les URL signées permettent de servir un fichier privé pendant une durée
    limitée sans exposer les identifiants du bucket — la vérification des
    droits reste du côté FastAPI (voir GET /api/files/{id}).

    Exemples de configuration :
    - Supabase : endpoint ``https://<project_ref>.supabase.co/storage/v1/s3``,
      région = région du projet, clés générées dans Project Settings → Storage
      → S3 Access Keys ;
    - Tigris : endpoint ``https://fly.storage.tigris.dev``, région ``auto`` ;
    - Backblaze B2 : endpoint ``https://s3.<region>.backblazeb2.com`` (région
      du bucket), clés = Application Key lecture/écriture.
    """

    backend = "s3"

    def __init__(
        self,
        endpoint_url: str,
        region_name: str,
        access_key_id: str,
        secret_access_key: str,
        bucket: str,
    ):
        import boto3  # import tardif : inutile en développement local
        from botocore.config import Config

        self.bucket = bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            region_name=region_name,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            # SigV4 + adressage par chemin : requis par Backblaze B2, pris en
            # charge par tous les fournisseurs (Tigris, Supabase, B2).
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
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

    def presigned_url(self, key: str, expires_seconds: int = 900, content_disposition: Optional[str] = None) -> Optional[str]:
        params = {"Bucket": self.bucket, "Key": normalize_key(key)}
        if content_disposition:
            params["ResponseContentDisposition"] = content_disposition
        return self._client.generate_presigned_url("get_object", Params=params, ExpiresIn=expires_seconds)


_storage: Optional[StorageService] = None


def get_storage() -> StorageService:
    """Fabrique singleton du backend de stockage (STORAGE_BACKEND=local|s3)."""
    global _storage
    if _storage is not None:
        return _storage

    backend = os.getenv("STORAGE_BACKEND", "local").strip().lower()
    if backend == "s3":
        endpoint = os.getenv("STORAGE_ENDPOINT_URL", "")
        region = os.getenv("STORAGE_REGION", "")
        access_key = os.getenv("STORAGE_ACCESS_KEY_ID", "")
        secret_key = os.getenv("STORAGE_SECRET_ACCESS_KEY", "")
        bucket = os.getenv("STORAGE_BUCKET", "")
        if not all([endpoint, region, access_key, secret_key, bucket]):
            raise StorageError(
                "STORAGE_BACKEND=s3 exige STORAGE_ENDPOINT_URL, STORAGE_REGION, "
                "STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY et STORAGE_BUCKET "
                "dans l'environnement (Tigris Data, Supabase Storage ou Backblaze B2)"
            )
        _storage = S3CompatibleStorage(endpoint, region, access_key, secret_key, bucket)
    else:
        from ..db import STORAGE_LOCAL_DIR

        _storage = LocalStorage(STORAGE_LOCAL_DIR)

    log.info("Backend de stockage actif: %s (bucket=%s)", _storage.backend, getattr(_storage, "bucket", "-"))
    return _storage


def presigned_url_or_none(
    key: str,
    expires_seconds: Optional[int] = None,
    content_disposition: Optional[str] = None,
) -> Optional[str]:
    """URL signée si le backend actif en produit (s3), sinon None -
    l'appelant retombe alors sur le streaming FastAPI."""
    if expires_seconds is None:
        expires_seconds = int(os.getenv("STORAGE_SIGNED_URL_EXPIRY", "900"))
    try:
        return get_storage().presigned_url(key, expires_seconds, content_disposition)
    except Exception as exc:  # jamais bloquant : le streaming reste possible
        log.warning("Génération d'URL signée impossible pour %s: %s", key, exc)
        return None
