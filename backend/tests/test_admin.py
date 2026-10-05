"""Back-office : login durci, CRUD/upload borné, job d'import en erreur."""
from __future__ import annotations

import io
import zipfile


def test_admin_login_ok_et_mauvais_jeton(client):
    r = client.post("/api/admin/login", json={"email": "admin@example.com", "token": "mauvais"})
    assert r.status_code == 401
    r = client.post("/api/admin/login", json={"email": "admin@example.com", "token": "test-admin-token"})
    assert r.status_code == 200
    assert "session_token" not in r.json()
    assert dict(client.cookies).get("admin_session")


def test_routes_admin_sans_session_401(client):
    for method, path in (("get", "/api/admin/stats"), ("get", "/api/admin/epreuves"), ("get", "/api/admin/signalements")):
        r = getattr(client, method)(path)
        assert r.status_code == 401, path


def test_update_statut_invalide_refuse(admin, epreuve_gratuite):
    r = admin.put(f"/api/admin/epreuves/{epreuve_gratuite}", json={"statut": "nimporte-quoi"})
    assert r.status_code == 400


def test_publication_depuis_formulaire_persiste_puis_publie(admin):
    """Reproduit le flux du bouton « Publier » du back-office : le frontend
    ENREGISTRE d'abord le formulaire (persister → POST puis PUT avec le
    tableau `sujets` et les `filieres` choisies), puis appelle /publish.
    Pavé la régression « publication refusée alors que sujets/séries
    affichés dans le formulaire » (revue 2026-09-18)."""
    payload = {
        "niveau": "SECONDAIRE",
        "classe": "terminale",
        "evaluation": "BAC",
        "matiere": "Mathématiques",
        "annee": "2026",
        "duree": "3h",
        "coefficient": "5",
        "gratuit": False,
        "filieres": ["C", "TI"],
        "sujets": [
            {"index": 0, "contenu_markdown": "# Sujet\n\n$f(x)=x^2$.", "corrige_markdown": "# Corrigé\n\n$x=0$."}
        ],
    }
    r = admin.post("/api/admin/epreuves", json=payload)
    assert r.status_code == 200, r.text
    eid = r.json()["id"]

    detail = admin.get(f"/api/admin/epreuves/{eid}").json()
    assert detail["filieres"] == ["C", "TI"]
    assert detail["sujets"][0]["contenu_markdown"].startswith("# Sujet")

    # Re-édition (PUT, même forme que `persister`) puis publication.
    r = admin.put(f"/api/admin/epreuves/{eid}", json=payload)
    assert r.status_code == 200, r.text
    r = admin.post(f"/api/admin/epreuves/{eid}/publish")
    assert r.status_code == 200, r.text

    detail = admin.get(f"/api/admin/epreuves/{eid}").json()
    assert detail["statut"] == "publie"
    assert detail["filieres"] == ["C", "TI"]
    assert _has_any_sujet_admin(admin, eid)

    r = admin.delete(f"/api/admin/epreuves/{eid}")
    assert r.status_code == 200


def _has_any_sujet_admin(admin, epreuve_id: str) -> bool:
    detail = admin.get(f"/api/admin/epreuves/{epreuve_id}").json()
    return any(s["contenu_markdown"].strip() for s in detail["sujets"])


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


def test_epreuve_creation_sans_pre_remplissage(admin):
    """Régression 2026-09-18 : sauvegarder un brouillon dont les champs
    obligatoires sont vides ne doit PAS les pré-remplir à la place (niveau
    → « SECONDAIRE », classe → « terminale », évaluation → « AUTRE »).
    Aucune valeur n'est inventée : les champs restent vides tels quels —
    l'interface bloque l'enregistrement côté formulaire, le serveur
    conserve fidèlement les valeurs fournies."""
    r = admin.post(
        "/api/admin/epreuves",
        json={"contenu_markdown": "# Sujet", "filieres": []},
    )
    assert r.status_code == 200, r.text
    eid = r.json()["id"]
    detail = admin.get(f"/api/admin/epreuves/{eid}").json()
    assert detail["niveau"] == ""
    assert detail["classe"] == ""
    assert detail["evaluation"] == ""
    admin.delete(f"/api/admin/epreuves/{eid}")


def test_epreuve_update_annee_vide(admin, epreuve_gratuite):
    """Mettre l'année d'une épreuve à vide ne doit pas planter (clé de
    stockage utilisée : convention '0000')."""
    r = admin.put(f"/api/admin/epreuves/{epreuve_gratuite}", json={"annee": ""})
    assert r.status_code == 200, r.text
    detail = admin.get(f"/api/admin/epreuves/{epreuve_gratuite}").json()
    assert detail["annee"] == ""


def test_suppression_epreuve_en_retenue_ne_largit_jamais_l_acces(admin, eleve, epreuve_payante):
    """Régression 2026-09 : la suppression d'une épreuve ayant un
    abonnement PAYÉ actif doit (a) RÉUSSIR malgré la clé étrangère
    (subscriptions.epreuve_id), (b) garantir que l'abonnement devient
    « annulee » — jamais « active » avec un epreuve_id NULL, ce qui en
    ferait un pass large (classe/évaluation) payé pour une seule épreuve
    (voir `covered_epreuves_condition`), et (c) ne jamais ouvrir l'accès à
    une autre épreuve payante."""
    # Épreuve de contrôle : le PAIEMENT ciblé ne doit jamais la couvrir.
    r = admin.post(
        "/api/admin/epreuves",
        json={
            "niveau": "SECONDAIRE",
            "classe": "terminale",
            "evaluation": "BAC",
            "matiere": "Controle Immuable",
            "annee": "2023",
            "gratuit": False,
            "filieres": ["D"],
            "contenu_markdown": "# Sujet contrôle",
        },
    )
    assert r.status_code == 200, r.text
    autre = r.json()["id"]
    assert admin.post(f"/api/admin/epreuves/{autre}/publish").status_code == 200

    # L'élève achète l'accès à la première épreuve payante (webhook simulé).
    r = eleve.post(
        "/api/subscriptions/checkout",
        json={"scope": "epreuve", "epreuve_id": epreuve_payante, "provider": "orange"},
    )
    assert r.status_code == 200, r.text
    ref = r.json()["reference_agregateur"]
    sub_id = r.json()["subscription_id"]
    assert (
        eleve.post("/api/payments/simulate-webhook", json={"reference_agregateur": ref}).status_code
        == 200
    )
    assert eleve.get(f"/api/epreuves/{epreuve_payante}").status_code == 200

    # Suppression admin : doit RÉUSSIR malgré l'abonnement actif qui pointe
    # sur l'épreuve (avait : 500 `IntegrityError`).
    assert admin.delete(f"/api/admin/epreuves/{epreuve_payante}").status_code == 200, "suppression épreuve"

    # L'abonnement est ANNULÉ et détaché de l'épreuve supprimée : il ne peut
    # plus servir de pass large ni référencer un enregistrement disparu.
    from app.db import SessionLocal
    from app.db_models import SubscriptionORM

    with SessionLocal() as db:
        sub = db.query(SubscriptionORM).filter(SubscriptionORM.id == sub_id).one()
        assert sub.statut == "annulee"
        assert sub.epreuve_id is None

    # L'épreuve supprimée répond 404, et l'autre épreuve payante RESTE
    # verrouillée pour cet élève (aucun élargissement d'accès).
    assert eleve.get(f"/api/epreuves/{epreuve_payante}").status_code == 404
    assert eleve.get(f"/api/epreuves/{autre}").status_code == 403


def test_admin_detail_resigne_les_urls_images(admin, epreuve_gratuite):
    """Régression 2026-09 (REVUE_BACKEND.md §1) : le détail admin re-signe
    les balises images du Markdown renvoyé — un jeton périmé stocké (lié à
    un statut/fichier antérieur) donne un lien mort et casse le matching
    frontend de la balise (REVUE_FRONTEND.md F1)."""
    import io
    import re

    from PIL import Image

    from app.core import signing

    buf = io.BytesIO()
    Image.new("RGB", (10, 10), (200, 30, 40)).save(buf, format="PNG")
    r = admin.post(
        f"/api/admin/epreuves/{epreuve_gratuite}/images",
        files={"file": ("fig.png", buf.getvalue(), "image/png")},
        data={"cible": "sujet"},
    )
    assert r.status_code == 200, r.text
    img = r.json()

    # Markdown stocké avec un jeton volontairement périmé (simulation d'un
    # upload sous un ancien statut/chef de clé).
    stale = "jeton-perime-de-test"
    md = f"# Titre\n\n![figure](/api/files/{img['id']}?token={stale}#w=300)"
    assert (
        admin.put(
            f"/api/admin/epreuves/{epreuve_gratuite}",
            json={"contenu_markdown": md},
        ).status_code
        == 200
    )

    detail = admin.get(f"/api/admin/epreuves/{epreuve_gratuite}").json()
    cas = detail["sujets"][0]["contenu_markdown"]
    assert stale not in cas
    m = re.search(
        r"!\[figure\]\(/api/files/([0-9a-z]+)\?token=([^)#]+)#w=300\)",
        cas,
    )
    assert m, cas
    fid, token = m.group(1), m.group(2)
    assert fid == img["id"]
    assert signing.verify_file_token(fid, epreuve_gratuite, "publie", token)
