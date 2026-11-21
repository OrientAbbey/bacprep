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

import io
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Protocol

from .logging_config import get_logger

log = get_logger("storage")


class StorageError(RuntimeError):
    """Erreur de stockage (clé invalide, objet introuvable à l'écriture...)."""


class _IterChunks(io.RawIOBase):
    """Adaptateur ``file-like`` en lecture autour d'un itérable de ``bytes``.

    boto3 exige un objet fichier pour ``upload_fileobj`` ; l'export produit des
    blocs au fil de l'eau. On ne construit donc JAMAIS l'objet complet en
    mémoire : la classe se contente de servir le bloc suivant, en
    réassemblant les ``memoryview`` que ``zipfile`` peut émettre.
    """

    def __init__(self, chunks):
        """Initialise l'adaptateur avec l'itérable de blocs à consommer.

        Args:
            chunks: itérable de ``bytes``, ``bytearray`` ou ``memoryview``.
        """
        self._it = iter(chunks)
        self._buf = b""
        self._pos = 0

    def readable(self) -> bool:
        """Indique que l'objet est en lecture seule (contrat ``RawIOBase``)."""
        return True

    def seekable(self) -> bool:
        """Indique que l'objet ne permet pas de déplacement (flux séquentiel)."""
        return False

    def writable(self) -> bool:
        """Indique que l'objet ne permet pas d'écriture."""
        return False

    def read(self, size: int = -1) -> bytes:
        """Renvoie au plus ``size`` octets, en ne puisant dans l'itérable que
        le nécessaire pour satisfaire la demande.

        Args:
            size: nombre d'octets attendus ; ``-1`` signifie « tout le reste ».

        Returns:
            Les octets disponibles (éventuellement moins que ``size`` en fin
            de flux).
        """
        # `zipfile` demande des blocs de taille fixe ; on sert exactement ce
        # qu'il demande pour ne pas charger plus que nécessaire.
        while len(self._buf) - self._pos < size:
            try:
                bloc = next(self._it)
            except StopIteration:
                break
            bloc = bytes(bloc) if isinstance(bloc, (bytearray, memoryview)) else bloc
            reste = self._buf[self._pos:]
            self._buf = reste + bloc
            self._pos = 0
        out = self._buf[self._pos: self._pos + size]
        self._pos += len(out)
        if self._pos >= len(self._buf):
            self._buf = b""
            self._pos = 0
        return out

    def readinto(self, view) -> int:
        """Lit directement dans le tampon ``view`` et renvoie le nombre
        d'octets écrits (évite une copie supplémentaire pour boto3)."""
        data = self.read(len(view))
        view[: len(data)] = data
        return len(data)


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

    def put_bytes(self, key: str, data: bytes, mime_type: str = "") -> None:
        """Écrit un objet entier sous ``key``, avec son type MIME si connu."""
        ...

    def get_bytes(self, key: str) -> bytes:
        """Lit et renvoie l'objet entier ; lève ``StorageError`` s'il est absent."""
        ...

    def put_stream(
        self, key: str, chunks, size: Optional[int] = None, mime_type: str = ""
    ) -> None:
        """Écrit un objet SANS jamais le maintenir entier en mémoire.

        `chunks` est un itérable de `bytes` (blocs de 1 Mo en pratique). Les
        backends locaux et S3 surchargent cette méthode ; l'implémentation par
        défaut ci-dessous retombe sur `put_bytes` en assemblant le tout, ce qui
        reste correct et suffit à l'import normal (fichiers plafonnés à 10 Mo).
        """
        data = b"".join(chunks)
        if size is not None and len(data) != size:
            raise StorageError(
                f"Taille annoncée incohérente pour {key!r}: {len(data)} != {size}"
            )
        self.put_bytes(key, data, mime_type)

    def open_read(self, key: str, chunk_size: int = 1024 * 1024):
        """Itère sur l'objet par blocs, sans le charger entièrement.

        Utilisé par l'export : une sauvegarde de plusieurs Go ne doit jamais
        résider en mémoire. L'implémentation par défaut s'appuie sur
        `get_bytes` (correct, mais là on charge tout d'un coup) ; les backends
        locaux et S3 surchargent pour lire réellement en flux.
        """
        yield self.get_bytes(key)

    def delete(self, key: str) -> None:
        """Supprime l'objet ; une clé absente est tolérée (suppression
        idempotente, nécessaire lors des remplacements de fichiers)."""
        ...

    def exists(self, key: str) -> bool:
        """Indique si l'objet existe, sans le charger."""
        ...

    def list_objects(self, prefix: str) -> list[dict]:
        """Liste les objets sous un préfixe : `[{cle, taille, modifie}, ...]`.

        `modifie` est TOUJOURS un `datetime` aware, quel que soit le backend :
        le backend local tire le `mtime` du disque, mais le convertir ici évite
        à chaque appelant de deviner quel type il a sous les mains.

        Utilisé pour présenter la liste des sauvegardes existantes. Les
        backends qui ne savent pas énumérer lèvent `NotImplementedError` :
        mieux vaut une liste vide affichable qu'un inventaire faux.
        """
        raise NotImplementedError

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
        """Prépare le répertoire racine dans lequel les clés sont résolues.

        Args:
            root: dossier racine, créé s'il n'existe pas.
        """
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        """Résout une clé en chemin disque, en vérifiant qu'il reste sous la
        racine (double garde anti path-traversal après ``normalize_key``)."""
        path = (self.root / normalize_key(key)).resolve()
        # Double garde après resolve() : la clé ne doit jamais sortir de la racine.
        path.relative_to(self.root)
        return path

    def put_bytes(self, key: str, data: bytes, mime_type: str = "") -> None:
        """Écrit les octets sur disque ; le type MIME est ignoré en local
        (le service FastAPI le retrouve depuis la base)."""
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def get_bytes(self, key: str) -> bytes:
        """Lit le fichier ; lève ``StorageError`` s'il n'existe pas."""
        path = self._path(key)
        if not path.is_file():
            raise StorageError(f"Objet introuvable: {key}")
        return path.read_bytes()

    def put_stream(self, key: str, chunks, size: Optional[int] = None, mime_type: str = "") -> None:
        """Écrit les blocs directement sur disque (mémoire constante) et
        vérifie la taille annoncée si elle est fournie."""
        # Écriture directe sur disque : la taille peut dépasser la mémoire.
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as out:
            for chunk in chunks:
                out.write(chunk)
        if size is not None and path.stat().st_size != size:
            raise StorageError(
                f"Taille annoncée incohérente pour {key!r}: {path.stat().st_size} != {size}"
            )

    def open_read(self, key: str, chunk_size: int = 1024 * 1024):
        """Lit le fichier par blocs de ``chunk_size`` octets (export en flux)."""
        path = self._path(key)
        if not path.is_file():
            raise StorageError(f"Objet introuvable: {key}")
        with path.open("rb") as src:
            while True:
                bloc = src.read(chunk_size)
                if not bloc:
                    break
                yield bloc

    def delete(self, key: str) -> None:
        """Supprime le fichier puis remonte les dossiers parents devenus vides."""
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
        """Indique si le fichier existe sur disque."""
        return self._path(key).is_file()

    def list_objects(self, prefix: str) -> list[dict]:
        """Liste récursivement les fichiers sous le préfixe, avec leur
        taille et leur date de modification UTC (contrat ``StorageService``)."""
        base = self.root / normalize_key(prefix)
        if not base.is_dir():
            return []
        trouves: list[dict] = []
        for chemin in sorted(base.rglob("*")):
            if not chemin.is_file():
                continue
            stat = chemin.stat()
            trouves.append(
                {
                    "cle": chemin.relative_to(self.root).as_posix(),
                    "taille": stat.st_size,
                    "modifie": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
                }
            )
        return trouves

    def presigned_url(self, key: str, expires_seconds: int = 900, content_disposition: Optional[str] = None) -> Optional[str]:
        """Pas d'URL signée en local : toujours ``None`` (le service FastAPI
        sert le fichier directement)."""
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
        """Crée le client boto3 (import tardif : inutile en développement).

        Args:
            endpoint_url: URL S3 du fournisseur.
            region_name: région du bucket.
            access_key_id, secret_access_key: identifiants d'accès.
            bucket: nom du bucket privé existant.
        """
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
        """Dépose l'objet entier dans le bucket, avec son Content-Type."""
        extra = {"ContentType": mime_type} if mime_type else {}
        self._client.put_object(Bucket=self.bucket, Key=normalize_key(key), Body=data, **extra)

    def get_bytes(self, key: str) -> bytes:
        """Télécharge l'objet et le renvoie entier en mémoire."""
        resp = self._client.get_object(Bucket=self.bucket, Key=normalize_key(key))
        return resp["Body"].read()

    def put_stream(self, key: str, chunks, size: Optional[int] = None, mime_type: str = "") -> None:
        """Envoie les blocs via ``upload_fileobj`` (multipart au-delà du
        seuil AWS) : la mémoire reste constante quelle que soit la taille.
        Vérifie la taille annoncée par un ``head_object`` si elle est fournie."""
        # `upload_fileobj` déclenche le multipart AWS au-delà du seuil : la
        # mémoire reste constante quelle que soit la taille de l'objet. Le
        # ContentType est fixé par un put_object vide préalable, upload_fileobj
        # ne le portant pas.
        key = normalize_key(key)
        if mime_type:
            self._client.put_object(Bucket=self.bucket, Key=key, Body=b"", ContentType=mime_type)
        else:
            self._client.put_object(Bucket=self.bucket, Key=key, Body=b"")
        self._client.upload_fileobj(_IterChunks(chunks), self.bucket, key)
        if size is not None:
            if self._client.head_object(Bucket=self.bucket, Key=key)["ContentLength"] != size:
                raise StorageError(
                    f"Taille annoncée incohérente pour {key!r}: "
                    f"{self._client.head_object(Bucket=self.bucket, Key=key)['ContentLength']} != {size}"
                )

    def open_read(self, key: str, chunk_size: int = 1024 * 1024):
        """Itère sur l'objet S3 par blocs, en fermant toujours le corps
        de réponse même si le consommateur interrompt la lecture."""
        resp = self._client.get_object(Bucket=self.bucket, Key=normalize_key(key))
        body = resp["Body"]
        try:
            while True:
                bloc = body.read(chunk_size)
                if not bloc:
                    break
                yield bloc
        finally:
            body.close()

    def delete(self, key: str) -> None:
        """Supprime l'objet du bucket (idempotent côté S3)."""
        self._client.delete_object(Bucket=self.bucket, Key=normalize_key(key))

    def exists(self, key: str) -> bool:
        """Teste l'existence par ``head_object``, sans télécharger l'objet."""
        import botocore.exceptions

        try:
            self._client.head_object(Bucket=self.bucket, Key=normalize_key(key))
            return True
        except botocore.exceptions.ClientError:
            return False

    def list_objects(self, prefix: str) -> list[dict]:
        """Liste les objets sous le préfixe en parcourant toutes les pages
        de ``list_objects_v2`` (le bucket peut en contenir plus de 1000)."""
        trouves: list[dict] = []
        pagineur = self._client.get_paginator("list_objects_v2")
        for page in pagineur.paginate(Bucket=self.bucket, Prefix=normalize_key(prefix)):
            for objet in page.get("Contents", []):
                trouves.append(
                    {
                        "cle": objet["Key"],
                        "taille": objet.get("Size", 0),
                        "modifie": objet.get("LastModified"),
                    }
                )
        return trouves

    def presigned_url(self, key: str, expires_seconds: int = 900, content_disposition: Optional[str] = None) -> Optional[str]:
        """Génère une URL signée valable ``expires_seconds`` ; le
        ``content_disposition`` force le téléchargement côté navigateur."""
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
