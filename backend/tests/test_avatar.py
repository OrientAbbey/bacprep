"""Photo de profil : validation, traitement (carré, EXIF retiré), cache, suppression, RGPD."""
from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image


@pytest.fixture(autouse=True)
def _sans_avatar(eleve):
    """Le compte de test est partagé : chaque test part sans photo (et n'en laisse pas)."""
    eleve.delete("/api/me/avatar")
    yield
    eleve.delete("/api/me/avatar")


def _png(taille=(400, 200), couleur=(200, 30, 30), mode="RGB", fmt="PNG") -> bytes:
    b = BytesIO()
    Image.new(mode, taille, couleur).save(b, format=fmt)
    return b.getvalue()


def _envoyer(client, contenu, nom="photo.png", mime="image/png"):
    return client.post("/api/me/avatar", files={"file": (nom, contenu, mime)})


def test_envoi_lecture_carre_256_webp(eleve):
    assert eleve.get("/api/me/avatar").status_code == 404
    assert eleve.get("/api/auth/me").json()["avatar_version"] is None
    r = _envoyer(eleve, _png())
    assert r.status_code == 200, r.text
    version = r.json()["avatar_version"]
    assert eleve.get("/api/auth/me").json()["avatar_version"] == version
    g = eleve.get("/api/me/avatar")
    assert g.status_code == 200 and g.headers["content-type"] == "image/webp"
    img = Image.open(BytesIO(g.content))
    assert img.format == "WEBP" and img.size == (256, 256)  # recadrée en carré
    assert "private" in g.headers["cache-control"]


def test_cache_conditionnel_304(eleve):
    _envoyer(eleve, _png())
    etag = eleve.get("/api/me/avatar").headers["etag"]
    assert eleve.get("/api/me/avatar", headers={"If-None-Match": etag}).status_code == 304


def test_metadonnees_exif_supprimees(eleve):
    img = Image.new("RGB", (300, 300), (10, 120, 10))
    exif = img.getexif()
    exif[0x010F] = "AppareilSecret"  # fabricant
    b = BytesIO()
    img.save(b, format="JPEG", exif=exif)
    assert b"AppareilSecret" in b.getvalue()  # la métadonnée est bien dans l'original
    assert _envoyer(eleve, b.getvalue(), "p.jpg", "image/jpeg").status_code == 200
    assert b"AppareilSecret" not in eleve.get("/api/me/avatar").content


def test_refus_fichier_non_image_et_trop_lourd(eleve):
    r = _envoyer(eleve, b"<html><script>alert(1)</script></html>", "x.png", "image/png")
    assert r.status_code == 415
    assert _envoyer(eleve, b"A" * (2 * 1024 * 1024 + 10)).status_code == 413
    assert eleve.get("/api/me/avatar").status_code == 404  # rien n'a été enregistré


def test_remplacement_suppression_et_acces_reserve(eleve):
    _envoyer(eleve, _png())
    v1 = eleve.get("/api/auth/me").json()["avatar_version"]
    assert _envoyer(eleve, _png(couleur=(0, 0, 255))).status_code == 200
    assert eleve.get("/api/auth/me").json()["avatar_version"] != v1
    assert eleve.delete("/api/me/avatar").status_code == 200
    assert eleve.get("/api/me/avatar").status_code == 404
    assert eleve.get("/api/auth/me").json()["avatar_version"] is None


def test_avatar_reserve_aux_comptes_connectes():
    from fastapi.testclient import TestClient

    import app.main as app_main

    anonyme = TestClient(app_main.app)  # client NEUF : le client partagé des fixtures est déjà connecté
    for r in (anonyme.get("/api/me/avatar"), anonyme.post("/api/me/avatar", files={"file": ("a.png", _png(), "image/png")}), anonyme.delete("/api/me/avatar")):
        assert r.status_code in (401, 403)


def test_export_et_suppression_de_compte_avec_avatar(eleve):
    _envoyer(eleve, _png())
    assert eleve.get("/api/me/export").json()["avatar"] == {"present": True}
    assert eleve.delete("/api/me/compte").status_code == 200  # échouerait en FK si l'avatar n'était pas purgé
