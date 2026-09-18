"""Back-office : login durci, CRUD/upload borné, job d'import en erreur."""
from __future__ import annotations

import io
import zipfile


def test_admin_login_ok_et_mauvais_jeton(client):
    r = client.post("/api/admin/login", json={"email": "admin@example.com", "token": "mauvais"})
    assert r.status_code == 401
    r = client.post("/api/admin/login", json={"email": "admin@example.com", "token": "test-admin-token"})
    assert r.status_code == 200
    assert "session_token" in r.json()


def test_routes_admin_sans_session_401(client):
    for method, path in (("get", "/api/admin/stats"), ("get", "/api/admin/epreuves"), ("get", "/api/admin/signalements")):
        r = getattr(client, method)(path)
        assert r.status_code == 401, path


def test_update_statut_invalide_refuse(admin, epreuve_gratuite):
    r = admin.put(f"/api/admin/epreuves/{epreuve_gratuite}", json={"statut": "nimporte-quoi"})
    assert r.status_code == 400


def test_upload_image_type_refuse(admin, epreuve_gratuite):
    r = admin.post(
        f"/api/admin/epreuves/{epreuve_gratuite}/images",
        files={"file": ("x.svg", b"<svg onload='alert(1)'/>", "image/svg+xml")},
        data={"cible": "sujet"},
    )
    assert r.status_code == 400  # SVG exclu (XSS stocké)


def test_upload_image_trop_grosse_refusee(admin, epreuve_gratuite):
    png = b"\x89PNG\r\n\x1a\n" + b"0" * (5 * 1024 * 1024 + 10)
    r = admin.post(
        f"/api/admin/epreuves/{epreuve_gratuite}/images",
        files={"file": ("big.png", png, "image/png")},
        data={"cible": "sujet"},
    )
    assert r.status_code == 400


def test_upload_image_ok(admin, epreuve_gratuite):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (200, 100), (10, 20, 30)).save(buf, format="PNG")
    r = admin.post(
        f"/api/admin/epreuves/{epreuve_gratuite}/images",
        files={"file": ("fig.png", buf.getvalue(), "image/png")},
        data={"cible": "sujet"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["url"].startswith("/api/files/")
    assert body["doublon_de"] is None


def test_import_zip_trop_grosse_job_en_erreur(admin):
    """Bug corrigé : le job restait 'pending' à jamais après un refus de
    taille — l'UI pollait indéfiniment."""
    # > 200 Mo déclaré via des entrées gonflées (zip bomb léger) :
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("2024/terminale/Maths/sujet.md", "x" * (201 * 1024 * 1024 // 10))
        zf.writestr("fill.md", "y" * (201 * 1024 * 1024 - (201 * 1024 * 1024 // 10)))
    r = admin.post(
        "/api/admin/import",
        files={"file": ("gros.zip", buf.getvalue(), "application/zip")},
    )
    assert r.status_code == 400
    jobs = admin.get("/api/admin/import/jobs").json()
    assert all(j["status"] in ("error", "done", "running") for j in jobs)
    assert not any(j["status"] == "pending" for j in jobs if j["filename"] == "gros.zip")


def test_import_zip_invalide_job_en_erreur(admin):
    r = admin.post(
        "/api/admin/import",
        files={"file": ("x.zip", b"pas-un-zip", "application/zip")},
    )
    assert r.status_code == 400
    jobs = admin.get("/api/admin/import/jobs").json()
    assert jobs and jobs[0]["status"] == "error"


def test_import_zip_chemin_absolu_job_en_erreur(admin):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("/etc/evil.md", "boom")
    r = admin.post(
        "/api/admin/import",
        files={"file": ("evil.zip", buf.getvalue(), "application/zip")},
    )
    assert r.status_code == 400


def test_epreuve_brouillon_sans_matiere_ni_annee(admin):
    """Matière et année sont optionnelles à la création : un brouillon
    peut être enregistré sans ces champs, l'admin les complète ensuite."""
    r = admin.post(
        "/api/admin/epreuves",
        json={"contenu_markdown": "# Sujet minimal", "filieres": []},
    )
    assert r.status_code == 200, r.text
    eid = r.json()["id"]
    detail = admin.get(f"/api/admin/epreuves/{eid}").json()
    assert detail["matiere"] == ""
    assert detail["annee"] == ""
    # Nettoyage.
    admin.delete(f"/api/admin/epreuves/{eid}")


def test_epreuve_update_annee_vide(admin, epreuve_gratuite):
    """Mettre l'année d'une épreuve à vide ne doit pas planter (clé de
    stockage utilisée : convention '0000')."""
    r = admin.put(f"/api/admin/epreuves/{epreuve_gratuite}", json={"annee": ""})
    assert r.status_code == 200, r.text
    detail = admin.get(f"/api/admin/epreuves/{epreuve_gratuite}").json()
    assert detail["annee"] == ""
