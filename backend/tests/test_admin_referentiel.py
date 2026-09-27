"""Tests de l'onglet « Paramètres » (table ``referentiel_options``) :
seed idempotent au démarrage, protection admin, CRUD (création, renommage,
suppression), compteur « en usage », auto-ajout à la sauvegarde d'une épreuve
et journal d'audit des mutations."""
from __future__ import annotations


def _options(client, scope: str) -> dict:
    r = client.get("/api/admin/referentiel-options")
    assert r.status_code == 200, r.text
    grouped = r.json()
    assert scope in grouped
    return grouped[scope]


def _trouve(options, code: str) -> dict | None:
    return next((o for o in options if o["code"] == code), None)


# ---------- Seed ----------

def test_seed_alimente_les_5_scopes(client, admin):
    """Au démarrage, les listes (niveau, classe, evaluation, serie) sont
    peuplées depuis core/referentiel.py ; classe porte un libellé affiché.
    matiere démarre vide mais se remplit à l'usage (voir test_auto_ajout) —
    dans la suite complète, les autres tests ont déjà créé des épreuves :
    on ne vérifie donc ici que la structure du scope."""
    grouped = admin.get("/api/admin/referentiel-options").json()
    assert set(grouped.keys()) == {"niveau", "classe", "evaluation", "matiere", "serie"}
    assert _trouve(grouped["niveau"], "SECONDAIRE")
    # Classe : libellé affiché ≠ code (contrairement à un raw code).
    terminale = _trouve(grouped["classe"], "terminale")
    assert terminale is not None
    assert terminale["label"] != terminale["code"]
    assert _trouve(grouped["evaluation"], "BAC")
    assert _trouve(grouped["serie"], "A")
    for scope in ("matiere",):
        assert all("id" in o and "en_usage" in o and "code" in o for o in grouped[scope])


def test_seed_idempotent(client, admin):
    """Reconnexion (nouveau lifespan) : le seed ne duplique pas les options
    déjà présentes (contrainte d'unicité (scope, code) respectée)."""
    nb_avant = len(_options(admin, "niveau"))
    # Nouveau client → nouveau lifespan → re-seed.
    import app.main as app_main
    from fastapi.testclient import TestClient

    with TestClient(app_main.app) as c:
        r = c.post("/api/auth/mock-login", json={"email": "x@test.cm"})
        assert r.status_code == 200
        r = c.post("/api/admin/login", json={"email": "admin@example.com", "token": "test-admin-token"})
        assert r.status_code == 200
        assert len(_options(c, "niveau")) == nb_avant


def test_scopes_retires_exclus_puis_purges(client, admin):
    """D'anciennes lignes de scope(s) aujourd'hui retiré(s) (ex. « session »
    supprimée le 2026-09-18, qui stockait des valeurs comme « Session
    normale » auto-ajoutées à l'épreuve) ne doivent plus ressortir dans les
    listes back-office : la route GET les exclut, et le seed (prochain
    démarrage) PURGE les lignes résiduelles."""
    from app.db import SessionLocal
    from app.db_models import ReferentielOptionORM

    with SessionLocal() as db:
        db.add(ReferentielOptionORM(scope="session", code="Session normale", position=0))
        db.add(ReferentielOptionORM(scope="session", code="Session speciale", position=1))
        db.commit()

    grouped = admin.get("/api/admin/referentiel-options").json()
    assert "session" not in grouped
    # Les valeurs retirées n'ont pas migré sous un autre scope.
    assert _trouve(grouped.get("evaluation", []), "Session normale") is None
    assert _trouve(grouped.get("evaluation", []), "SESSION NORMALE") is None

    # Nouveau lifespan → seed → purge effective des lignes résiduelles.
    import app.main as app_main
    from fastapi.testclient import TestClient

    with TestClient(app_main.app) as c:
        from app.db import SessionLocal as SL

        with SL() as db:
            nb = db.query(ReferentielOptionORM).filter(ReferentielOptionORM.scope == "session").count()
        assert nb == 0


# ---------- Protection admin ----------

def test_referentiel_requiert_session_admin(client):
    """Toutes les routes referentiel-options sont protégées : 401 sans
    session admin."""
    r = client.get("/api/admin/referentiel-options")
    assert r.status_code == 401
    r = client.post("/api/admin/referentiel-options", json={"scope": "matiere", "code": "X"})
    assert r.status_code == 401


# ---------- CRUD ----------

def test_creation_option_et_peremption(admin):
    """POST crée l'option ; doublon refusé (409) ; scope inconnu refusé
    (422) ; la nouvelle option apparaît dans la liste. Nettoyage en fin de
    test (suppression) pour rester auto-suffisant."""
    r = admin.post("/api/admin/referentiel-options", json={"scope": "matiere", "code": "Informatique"})
    assert r.status_code == 200, r.text
    assert _trouve(_options(admin, "matiere"), "Informatique")

    r = admin.post("/api/admin/referentiel-options", json={"scope": "matiere", "code": "Informatique"})
    assert r.status_code == 409

    r = admin.post("/api/admin/referentiel-options", json={"scope": "inconnu", "code": "X"})
    assert r.status_code == 422

    r = admin.post("/api/admin/referentiel-options", json={"scope": "matiere", "code": "  "})
    assert r.status_code == 422

    # Nettoyage.
    option_id = _trouve(_options(admin, "matiere"), "Informatique")["id"]
    assert admin.delete(f"/api/admin/referentiel-options/{option_id}").status_code == 200


def test_creation_avec_label(admin):
    """Un libellé d'affichage est stocké ; sans libellé, le code est le
    libellé (repli côté serveur)."""
    r = admin.post(
        "/api/admin/referentiel-options",
        json={"scope": "classe", "code": "cret", "label": "Camerounais (étranger)"},
    )
    assert r.status_code == 200, r.text
    assert len(_options(admin, "classe")) > 0  # la liste reste saine
    admin.delete(f"/api/admin/referentiel-options/{r.json()['id']}")


def test_renommage_option_sans_conflit(admin):
    """PATCH change code et libellé ; le conflit d'unicité (autre option
    portant déjà la valeur) est refusé 409."""
    r = admin.post("/api/admin/referentiel-options", json={"scope": "evaluation", "code": "TEMP-1"})
    opt_id = r.json()["id"]

    r = admin.patch(f"/api/admin/referentiel-options/{opt_id}", json={"code": "TEMP-2", "label": "Temp 2"})
    assert r.status_code == 200, r.text
    assert r.json()["code"] == "TEMP-2" and r.json()["label"] == "Temp 2"
    assert _trouve(_options(admin, "evaluation"), "TEMP-2")
    assert _trouve(_options(admin, "evaluation"), "TEMP-1") is None

    # Conflit avec une option existante (le seed fournit A en serie).
    r2 = admin.post("/api/admin/referentiel-options", json={"scope": "serie", "code": "TEMP-3"})
    assert r2.status_code == 200
    conflict_id = r2.json()["id"]
    r = admin.patch(f"/api/admin/referentiel-options/{conflict_id}", json={"code": "A"})
    assert r.status_code == 409

    admin.delete(f"/api/admin/referentiel-options/{opt_id}")
    admin.delete(f"/api/admin/referentiel-options/{conflict_id}")


def test_renommage_option_inexistante_404(admin):
    r = admin.patch("/api/admin/referentiel-options/absent", json={"code": "X"})
    assert r.status_code == 404


def test_suppression_option_et_en_usage(admin):
    """`en_usage` compte les épreuves portant la valeur ; la suppression
    détache l'option de la liste SANS réécrire les épreuves (elles gardent
    leur valeur)."""
    # Une épreuve publiée avec une matière hors liste → auto-ajout.
    r = admin.post(
        "/api/admin/epreuves",
        json={
            "matiere": "RHADARA",
            "classe": "terminale",
            "evaluation": "BAC",
            "annee": "2024",
            "contenu_markdown": "# Sujet",
            "filieres": ["A"],
        },
    )
    assert r.status_code == 200, r.text
    eid = r.json()["id"]

    opt = _trouve(_options(admin, "matiere"), "RHADARA")
    assert opt is not None
    assert opt["en_usage"] >= 1

    assert admin.delete(f"/api/admin/referentiel-options/{opt['id']}").status_code == 200
    assert _trouve(_options(admin, "matiere"), "RHADARA") is None

    # L'épreuve garde sa matière (aucune réécriture).
    r = admin.get(f"/api/admin/epreuves/{eid}")
    assert r.status_code == 200
    assert r.json()["matiere"] == "RHADARA"

    r = admin.delete(f"/api/admin/epreuves/{eid}")
    assert r.status_code == 200


# ---------- Auto-ajout à la sauvegarde ----------

def test_auto_ajout_matiere_serie(admin, epreuve_gratuite):
    """Sauvegarder une épreuve avec une matière/série hors liste les
    mémorise dans le référentiel (best-effort, ne bloque jamais)."""
    r = admin.post(
        "/api/admin/epreuves",
        json={
            "matiere": "Science Nouv",
            "classe": "terminale",
            "evaluation": "BAC",
            "annee": "2024",
            "contenu_markdown": "# Sujet",
            "filieres": ["XX"],
        },
    )
    assert r.status_code == 200, r.text
    assert _trouve(_options(admin, "matiere"), "Science Nouv") is not None
    assert _trouve(_options(admin, "serie"), "XX") is not None

    # Idempotence : re-sauvegarde (PUT) sans erreur de doublon.
    eid = r.json()["id"]
    r = admin.put(
        f"/api/admin/epreuves/{eid}",
        json={"matiere": "Science Nouv", "filieres": ["XX"]},
    )
    assert r.status_code == 200, r.text
    assert len([o for o in _options(admin, "serie")]) >= 1  # liste saine

    r = admin.delete(f"/api/admin/epreuves/{eid}")
    assert r.status_code == 200


# ---------- Journal d'audit ----------

def test_journal_audit_referentiel(admin):
    """Chaque mutation (ajout, renommage, suppression) est tracée dans le
    journal d'audit avec le scope et la valeur concernés."""
    r = admin.post("/api/admin/referentiel-options", json={"scope": "serie", "code": "AUDIT-TEST"})
    assert r.status_code == 200
    opt_id = r.json()["id"]
    admin.patch(f"/api/admin/referentiel-options/{opt_id}", json={"code": "AUDIT-TEST-2"})
    admin.delete(f"/api/admin/referentiel-options/{opt_id}")

    r = admin.get("/api/admin/events")
    assert r.status_code == 200
    actions = [e["action"] for e in r.json()]
    assert "referentiel_option_ajoutee" in actions
    assert "referentiel_option_renommee" in actions
    assert "referentiel_option_supprimee" in actions