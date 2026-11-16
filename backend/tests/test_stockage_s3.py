"""Reproduction locale du backend de stockage S3 sans compte cloud.

On injecte un client boto3 factice dans ``S3CompatibleStorage`` : les scénarios
d'inventaire qui ont historiquement produit « Inventaire illisible » peuvent
ainsi être rejoués en CI (pagination S3, erreur `ClientError`, marqueur `_READY`
absent) sans dépendre de Render, Tigris, Supabase ou Backblaze.
"""
from __future__ import annotations

import io
import json
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

from app.core.export_service import NOM_INDEX, NOM_MANIFESTE, NOM_PRET, PREFIXE
from app.core.storage import S3CompatibleStorage
from app.routers import admin_sauvegardes


def _client_s3_erreur(code: str, operation: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "erreur S3 simulée"}}, operation)


class _Pagineur:
    """Pagineur `list_objects_v2` minimal, branché sur le stockage factice."""

    def __init__(self, client: "_ClientS3"):
        self.client = client

    def paginate(self, **kwargs):
        self.client.appels_pagination.append(kwargs)
        prefixe = kwargs["Prefix"]
        maintenant = datetime.now(timezone.utc)
        contents = [
            {"Key": cle, "Size": len(donnees), "LastModified": maintenant}
            for cle, donnees in self.client.objets.items()
            if cle.startswith(prefixe)
        ]
        yield {"Contents": contents}


class _ClientS3:
    def __init__(self, objets: dict[str, bytes] | None = None, erreur_liste: Exception | None = None):
        self.objets = objets or {}
        self.erreur_liste = erreur_liste
        self.appels_pagination: list[dict] = []

    def get_paginator(self, nom: str) -> _Pagineur:
        assert nom == "list_objects_v2"
        if self.erreur_liste:
            raise self.erreur_liste
        return _Pagineur(self)

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, **_kwargs) -> None:
        self.objets[Key] = Body

    def get_object(self, *, Bucket: str, Key: str) -> dict:
        return {"Body": io.BytesIO(self.objets[Key])}

    def head_object(self, *, Bucket: str, Key: str) -> dict:
        if Key not in self.objets:
            raise _client_s3_erreur("404", "HeadObject")
        return {"ContentLength": len(self.objets[Key])}

    def delete_object(self, *, Bucket: str, Key: str) -> None:
        self.objets.pop(Key, None)

    def generate_presigned_url(self, _operation: str, Params: dict, **_kwargs) -> str:
        return f"https://s3.local/{Params['Bucket']}/{Params['Key']}"


def _stockage_s3(monkeypatch, client: _ClientS3) -> S3CompatibleStorage:
    """Construit le vrai backend S3 avec un client boto3 remplacé."""
    monkeypatch.setattr(boto3, "client", lambda *_args, **_kwargs: client)
    return S3CompatibleStorage(
        "https://s3.local", "us-east-1", "cle-test", "secret-test", "bucket-test"
    )


def _sauvegarde_complete(prefixe: str) -> dict[str, bytes]:
    return {
        f"{prefixe}/{NOM_MANIFESTE}": json.dumps(
            {"epreuve_count": 1, "fichier_count": 1}
        ).encode("utf-8"),
        f"{prefixe}/{NOM_INDEX}": json.dumps(
            {"parties": [{"nom": "partie-1.zip", "octets": 10, "sha256": "a"}]}
        ).encode("utf-8"),
        f"{prefixe}/{NOM_PRET}": b"",
        f"{prefixe}/partie-1.zip": b"x" * 10,
    }


def test_inventaire_s3_liste_les_sauvegardes(admin, monkeypatch) -> None:
    """Le backend S3 à paginer renvoie le même inventaire que le stockage local."""
    prefixe = f"{PREFIXE}/2026-11-20T120000Z"
    client = _ClientS3(_sauvegarde_complete(prefixe))
    stockage = _stockage_s3(monkeypatch, client)
    monkeypatch.setattr(admin_sauvegardes, "get_storage", lambda: stockage)

    r = admin.get("/api/admin/sauvegardes")
    assert r.status_code == 200, r.text
    assert any(s["cle"] == prefixe for s in r.json()["sauvegardes"])
    assert client.appels_pagination
    assert client.appels_pagination[0]["Prefix"] == PREFIXE


def test_inventaire_s3_client_error_renvoie_503(admin, monkeypatch) -> None:
    """Une erreur S3 (accès refusé, bucket absent) n'est PAS un inventaire vide."""
    client = _ClientS3(
        erreur_liste=_client_s3_erreur("AccessDenied", "ListObjectsV2")
    )
    stockage = _stockage_s3(monkeypatch, client)
    monkeypatch.setattr(admin_sauvegardes, "get_storage", lambda: stockage)

    r = admin.get("/api/admin/sauvegardes")
    assert r.status_code == 503, r.text
    assert "stockage" in r.json()["detail"].lower()


def test_inventaire_s3_sans_marqueur_ignore_la_sauvegarde_recente(admin, monkeypatch) -> None:
    """`head_object` S3 renvoie une ClientError pour `_READY` absent : la
    sauvegarde récente est signalée, pas affichée comme restaurable."""
    prefixe = f"{PREFIXE}/2026-11-21T120000Z"
    objets = _sauvegarde_complete(prefixe)
    objets.pop(f"{prefixe}/{NOM_PRET}")
    client = _ClientS3(objets)
    stockage = _stockage_s3(monkeypatch, client)
    monkeypatch.setattr(admin_sauvegardes, "get_storage", lambda: stockage)

    r = admin.get("/api/admin/sauvegardes")
    assert r.status_code == 200, r.text
    ignoree = next((i for i in r.json()["ignorees"] if i["cle"] == prefixe), None)
    assert ignoree is not None, r.json()
    assert "_READY" in ignoree["raison"]
