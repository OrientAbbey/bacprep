"""API de sauvegarde (Phase 3 du plan `PLAN_SAUVEGARDES.md`).

Ces tests gardent les mêmes propriétés que le service, mais vues par l'MM :
ce qui compte ici, c'est qu'un visiteur ne passe pas, qu'un export démarre,
qu'une restauration exige deux appels, et qu'un rapport d'essai à blanc ne
promet rien.
"""
from __future__ import annotations

import json

import pytest

from app.core.export_service import NOM_INDEX, NOM_MANIFESTE, PREFIXE
from app.core.restore_service import MODE_DISASTER
from app.core.storage import get_storage
from app.db_models import Base, EpreuveFileORM, EpreuveORM


def _purger(db) -> None:
    """Vide le catalogue, les jobs et les notifications, sans toucher à la
    session admin.

    La base est partagée par tous les tests : sans ce nettoyage, un export
    emballerait les épreuves laissées par les tests précédents et les
    comptages deviennent faux.
    """
    from conftest import purger_catalogue

    purger_catalogue(db)


@pytest.fixture(autouse=True)
def stockage_propre():
    """ Vide le préfixe des sauvegardes avant chaque test.

    Le stockage local est un dossier unique partagé par toute la session de
    tests : sans ce nettoyage, l'inventaire accumulerait les sauvegardes des
    tests précédents et les comptages deviendraient faux.
    """
    from app.core.export_service import PREFIXE

    stockage = get_storage()
    for objet in stockage.list_objects(PREFIXE + "/"):
        stockage.delete(objet["cle"])
    yield


def _attendre(client, job_id: str, plafond: int = 200) -> dict:
    """Attend la fin d'un job de fond et renvoie son état.

    Le TestClient exécute les BackgroundTasks de Starlette de façon SYNCHRONE
    avant de rendre la main, mais l'écriture du statut se fait dans une autre
    session : on relit donc jusqu'à ce que le job soit terminal.
    """
    import time

    for _ in range(plafond):
        r = client.get(f"/api/admin/sauvegardes/jobs/{job_id}")
        assert r.status_code == 200, r.text
        etat = r.json()
        if etat["status"] in ("done", "error"):
            return etat
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} jamais terminé (dernier état: {etat['status']})")


# --------------------------------------------------------------------------
# Accès réservé à l'administration
# --------------------------------------------------------------------------


def test_visiteur_ne_peut_pas_lister(client) -> None:
    assert client.get("/api/admin/sauvegardes").status_code in (401, 403)


def test_eleve_ne_peut_pas_exporter(eleve) -> None:
    assert eleve.post("/api/admin/sauvegardes/export", json={}).status_code in (401, 403)


def test_visiteur_ne_peut_pas_restaurer(client) -> None:
    r = client.post(
        "/api/admin/sauvegardes/restore",
        json={"source": f"{PREFIXE}x", "mode": "bucket"},
    )
    assert r.status_code in (401, 403)


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------


def test_pieces_accompagnement_downloadables(admin, sauvegarde) -> None:
    """Manifeste, index et procédure se téléchargent.

    Ce sont les pièces qui rendent la sauvegarde AUTONOME : la procédure
    permet de la relire sans le dépôt, l'index de prouver que les parties
    sont intactes. La route de téléchargement est la seule voie d'accès.
    """
    for fichier, attendu in (
        ("manifest.json", b'"format": "bacprep-export"'),
        ("index.json", b"sha256"),
        # Un contenu, pas seulement un fichier présent : une procédure vide
        # est téléchargeable, donc le test passerait, et elle ne sert à rien
        # au moment où quelqu'un en aurait besoin.
        ("LISEZMOI.txt", "ESSAI À BLANC".encode("utf-8")),
    ):
        r = admin.get(f"/api/admin/sauvegardes/telecharger/{sauvegarde['cle']}/{fichier}")
        assert r.status_code == 200, f"{fichier} : {r.text}"
        assert attendu in r.content, fichier
        # `attachment` : le navigateur télécharge au lieu d'afficher le JSON
        # dans un onglet à la place du back-office.
        assert "attachment" in r.headers.get("content-disposition", "")


def test_export_cree_une_sauvegarde_listable(admin, epreuve_gratuite, db) -> None:
    """Le cycle nominal : un export, puis une sauvegarde visible à l'écran."""
    r = admin.post("/api/admin/sauvegardes/export", json={})
    assert r.status_code == 200, r.text
    job = _attendre(admin, r.json()["id"])
    assert job["status"] == "done", job
    assert job["kind"] == "export"
    assert job["parties_total"] == 1
    # La base est partagée entre les tests : on compare aux compteurs réels,
    # pas à des nombres absolus.
    attendu = db.query(EpreuveORM).count()
    assert job["total_fichiers"] == db.query(EpreuveFileORM).count()
    assert attendu >= 1

    r = admin.get("/api/admin/sauvegardes")
    assert r.status_code == 200, r.text
    inventaire = r.json()
    assert inventaire["total_octets"] > 0
    assert len(inventaire["sauvegardes"]) == 1
    sauvegarde = inventaire["sauvegardes"][0]
    assert sauvegarde["cle"].startswith(PREFIXE)
    assert sauvegarde["epreuves"] == attendu
    assert sauvegarde["fichiers"] == job["total_fichiers"]
    assert len(sauvegarde["parties"]) == 1
    assert sauvegarde["parties"][0]["nom"].endswith(".zip")
    assert sauvegarde["parties"][0]["sha256"]

    # Le contenu est bien là : manifeste, index et partie.
    stockage = get_storage()
    assert stockage.exists(f"{sauvegarde['cle']}/{NOM_MANIFESTE}")
    assert stockage.exists(f"{sauvegarde['cle']}/{NOM_INDEX}")
    assert stockage.exists(f"{sauvegarde['cle']}/{sauvegarde['parties'][0]['nom']}")


def test_export_ignore_la_destination_du_client(admin, epreuve_gratuite) -> None:
    """Un client ne choisit pas où l'on écrit : la clé vient du serveur.

    Sans cette règle, `destination` permettrait d'écraser une autre sauvegarde —
    ou n'importe quel préfixe du bucket.
    """
    r = admin.post(
        "/api/admin/sauvegardes/export",
        json={"destination": "epreuves/SECONDAIRE/2024/pirate"},
    )
    assert r.status_code == 200, r.text
    job = _attendre(admin, r.json()["id"])
    assert job["status"] == "done", job
    assert job["destination"].startswith(PREFIXE)
    assert job["destination"] != "epreuves/SECONDAIRE/2024/pirate"


def test_deux_exports_donne_deux_sauvegardes(admin, epreuve_gratuite) -> None:
    for _ in range(2):
        r = admin.post("/api/admin/sauvegardes/export", json={})
        assert _attendre(admin, r.json()["id"])["status"] == "done"
    inventaire = admin.get("/api/admin/sauvegardes").json()
    assert len(inventaire["sauvegardes"]) == 2
    # Deux horodatages au même.second se collisionneraient : l'unicité de la
    # destination est une propriété de l'outil, pas de l'horloge.
    assert len({s["cle"] for s in inventaire["sauvegardes"]}) == 2


def test_export_sur_catalogue_vide(admin, db) -> None:
    """Un catalogue vide donne une sauvegarde valide et vide — pas une erreur."""
    _purger(db)
    r = admin.post("/api/admin/sauvegardes/export", json={})
    job = _attendre(admin, r.json()["id"])
    assert job["status"] == "done", job
    assert job["total_fichiers"] == 0


# --------------------------------------------------------------------------
# Restauration : l'essai à blanc, puis l'écriture
# --------------------------------------------------------------------------


@pytest.fixture()
def sauvegarde(admin, epreuve_gratuite):
    """Une sauvegarde exploitable, prête à être restaurée."""
    r = admin.post("/api/admin/sauvegardes/export", json={})
    _attendre(admin, r.json()["id"])
    return admin.get("/api/admin/sauvegardes").json()["sauvegardes"][0]


def _reparer(admin, sauvegarde) -> None:
    """Remet le stockage d'aplomb après qu'un test l'ait vidé.

    Les tests partagent le stockage local ET la base. Sans réparation, la ligne
    `epreuve_files` d'un test survivrait à la suppression de son objet, et
    l'export suivant emballerait un catalogue dont les fichiers n'existent
    plus — un état que la production ne peut pas produire, donc inutile à
    tester. C'est le prix d'un stockage local unique pour toute la session.
    """
    r = admin.post(
        "/api/admin/sauvegardes/restore",
        json={
            "source": sauvegarde["cle"],
            "mode": "bucket",
            "dry_run": False,
            "confirme": True,
        },
    )
    assert r.status_code == 200, r.text
    assert _attendre(admin, r.json()["id"])["status"] == "done"


def test_essai_a_blanc_ecrit_rien(admin, sauvegarde, db) -> None:
    """Un appel nu est un ESSAI : ni la base ni les objets ne bougent."""
    avant = db.query(EpreuveFileORM).count()
    stockage = get_storage()
    cles = [f.storage_key for f in db.query(EpreuveFileORM).all()]
    # On casse le stockage : l'essai doit promettre de le réparer.
    for cle in cles:
        stockage.delete(cle)

    r = admin.post(
        "/api/admin/sauvegardes/restore",
        json={"source": sauvegarde["cle"], "mode": "bucket"},
    )
    assert r.status_code == 200, r.text
    job = _attendre(admin, r.json()["id"])
    assert job["status"] == "done", job
    rapport = job["report"]
    assert rapport["dry_run"] is True
    assert rapport["ecrits"] == avant  # ce qu'il s'apprête à faire
    # ... et il ne l'a PAS fait.
    for cle in cles:
        assert not stockage.exists(cle)
    _reparer(admin, sauvegarde)


def test_ecriture_refusee_sans_confirmation(admin, sauvegarde, db) -> None:
    """`dry_run=false` sans `confirme` : refusé, et rien n'est écrit."""
    cles = [f.storage_key for f in db.query(EpreuveFileORM).all()]
    stockage = get_storage()
    for cle in cles:
        stockage.delete(cle)

    r = admin.post(
        "/api/admin/sauvegardes/restore",
        json={
            "source": sauvegarde["cle"],
            "mode": "bucket",
            "dry_run": False,
            "confirme": False,
        },
    )
    assert r.status_code == 400
    assert "confirmation" in r.json()["detail"].lower()
    for cle in cles:
        assert not stockage.exists(cle)
    _reparer(admin, sauvegarde)


def test_mode_inconnu_refuse(admin, sauvegarde) -> None:
    r = admin.post(
        "/api/admin/sauvegardes/restore",
        json={"source": sauvegarde["cle"], "mode": "jeter-tout"},
    )
    # Le validateur Pydantic rejette avant le service.
    assert r.status_code == 422


def test_mode_complet_refuse_une_base_pleine(admin, sauvegarde, db) -> None:
    # La base est partagée : on vérifie qu'elle n'est PAS vide, et qu'elle ne
    # l'est toujours pas après le refus.
    assert db.query(EpreuveORM).count() > 0
    r = admin.post(
        "/api/admin/sauvegardes/restore",
        json={"source": sauvegarde["cle"], "mode": MODE_DISASTER, "dry_run": False,
              "confirme": True},
    )
    assert r.status_code == 409
    assert "épreuve" in r.json()["detail"]
    assert db.query(EpreuveORM).count() > 0


def test_essai_a_blanc_ne_se_confirme_pas(admin, sauvegarde) -> None:
    """`dry_run=true` ET `confirme=true` n'a pas de sens : on le refuse."""
    r = admin.post(
        "/api/admin/sauvegardes/restore",
        json={"source": sauvegarde["cle"], "mode": "bucket", "dry_run": True,
              "confirme": True},
    )
    assert r.status_code == 400


def test_recharge_ecrit_apres_confirmation(admin, sauvegarde, db) -> None:
    """Le deuxieme appel, confirmé, réécrit les objets et laisse la base
    intacte."""
    stockage = get_storage()
    avant = [(f.id, f.storage_key) for f in db.query(EpreuveFileORM).all()]
    for _, cle in avant:
        stockage.delete(cle)

    r = admin.post(
        "/api/admin/sauvegardes/restore",
        json={
            "source": sauvegarde["cle"],
            "mode": "bucket",
            "dry_run": False,
            "confirme": True,
        },
    )
    assert r.status_code == 200, r.text
    job = _attendre(admin, r.json()["id"])
    assert job["status"] == "done", job
    assert job["report"]["dry_run"] is False
    assert job["report"]["ecrits"] == len(avant)
    assert all(stockage.exists(cle) for _, cle in avant)
    assert [(f.id, f.storage_key) for f in db.query(EpreuveFileORM).all()] == avant


def test_source_inconnue_signalee(admin) -> None:
    """Une source qui n'existe pas produit un job en ERREUR, pas un job
    pendouillard."""
    r = admin.post(
        "/api/admin/sauvegardes/restore",
        json={"source": f"{PREFIXE}/2099-01-01T000000Z", "mode": "bucket"},
    )
    assert r.status_code == 200, r.text
    job = _attendre(admin, r.json()["id"])
    assert job["status"] == "error"
    assert job["report"]["erreurs"]


def test_restauration_incomplete_reste_une_erreur(admin, sauvegarde, db) -> None:
    """Si la sauvegarde est abîmée, le job doit finir en ÉCHEC.

    Une restauration incomplète qui s'afficherait « terminée » ferait croire
    que le catalogue est revenu alors qu'il ne l'est pas.
    """
    stockage = get_storage()
    # On supprime une partie ET son index devient faux : restauration impossible.
    stockage.delete(f"{sauvegarde['cle']}/{sauvegarde['parties'][0]['nom']}")
    r = admin.post(
        "/api/admin/sauvegardes/restore",
        json={"source": sauvegarde["cle"], "mode": "bucket", "dry_run": False,
              "confirme": True},
    )
    job = _attendre(admin, r.json()["id"])
    assert job["status"] == "error", job
    assert job["report"]["erreurs"]
    # Le stockage du catalogue n'a pas été touché : c'est la sauvegarde qui est
    # abîmée, pas le catalogue.
    for f in db.query(EpreuveFileORM).all():
        assert stockage.exists(f.storage_key)


# --------------------------------------------------------------------------
# Téléchargement et suppression
# --------------------------------------------------------------------------


def test_telechargement_dune_partie(admin, sauvegarde) -> None:
    nom = sauvegarde["parties"][0]["nom"]
    r = admin.get(f"/api/admin/sauvegardes/telecharger/{sauvegarde['cle']}/{nom}")
    assert r.status_code == 200, r.text
    # Le backend local ne fait pas d'URL signée : on doit servir les octets.
    contenu = r.content
    assert contenu[:2] == b"PK", "ce doit être une archive ZIP"
    assert len(contenu) == sauvegarde["parties"][0]["octets"]


def test_telechargement_refuse_une_cle_hors_sauvegardes(admin) -> None:
    """Le téléchargement ne doit pas servir d'accès général au bucket."""
    r = admin.get("/api/admin/sauvegardes/telecharger/epreuves/SECONDAIRE/2024/x/sujet.md")
    assert r.status_code == 400


def test_suppression_dune_sauvegarde(admin, sauvegarde) -> None:
    stockage = get_storage()
    assert stockage.exists(f"{sauvegarde['cle']}/{NOM_INDEX}")
    r = admin.delete(f"/api/admin/sauvegardes/{sauvegarde['cle']}")
    assert r.status_code == 200, r.text
    assert r.json()["objets"] >= 2
    assert not stockage.exists(f"{sauvegarde['cle']}/{NOM_INDEX}")
    assert admin.get("/api/admin/sauvegardes").json()["sauvegardes"] == []


def test_operations_tracees_dans_le_journal(admin, sauvegarde, db) -> None:
    """Export, restauration et suppression laissent une trace d'audit.

    Un export est un DUMP de toutes les données, et une suppression est
    irrattrapable. « Qui a fait ça » doit avoir une RÉPONSE : sans entrée dans
    `admin_events`, la seule réponse est l'absence, qui ne se distingue pas
    d'un journal jamais consulté.
    """
    from app.db_models import AdminEventORM

    # La purge est faite ICI, pas par la fixture : le journal d'audit est une
    # des tables préservées (le vider déconnecterait l'admin), donc l'état
    # laissé par les tests précédents y traîne. On repart donc de zéro pour
    # que les « absent » ci-dessous signifient vraiment « pas encore fait ».
    def purger_journal():
        db.query(AdminEventORM).filter(AdminEventORM.action.like("sauvegarde%")).delete()
        db.commit()

    def actions():
        return {
            r.action
            for r in db.query(AdminEventORM)
            .filter(AdminEventORM.action.like("sauvegarde%"))
            .all()
        }

    purger_journal()
    assert "sauvegarde_export_demande" not in actions()
    assert _attendre(admin, admin.post("/api/admin/sauvegardes/export", json={}).json()["id"])
    assert "sauvegarde_export_demande" in actions()

    # L'ESSAI est tracé séparément de l'écriture : un journal qui ne fait
    # qu'un seul « restauration » pour les deux ne dit pas si des données ont
    # été écrites.
    r = admin.post(
        "/api/admin/sauvegardes/restore",
        json={"source": sauvegarde["cle"], "mode": "bucket", "dry_run": True},
    )
    assert _attendre(admin, r.json()["id"])["status"] == "done"
    assert "sauvegarde_restauration_essai" in actions()
    assert "sauvegarde_restauration_ecriture" not in actions()

    r = admin.post(
        "/api/admin/sauvegardes/restore",
        json={
            "source": sauvegarde["cle"],
            "mode": "bucket",
            "dry_run": False,
            "confirme": True,
        },
    )
    assert _attendre(admin, r.json()["id"])["status"] == "done"
    assert "sauvegarde_restauration_ecriture" in actions()

    assert admin.delete(f"/api/admin/sauvegardes/{sauvegarde['cle']}").status_code == 200
    assert "sauvegarde_supprimee" in actions()


def test_suppression_refuse_une_cle_hors_sauvegardes(admin, epreuve_gratuite, db) -> None:
    """On ne doit pas pouvoir supprimer un fichier du catalogue par cette
    route."""
    cible = (
        db.query(EpreuveFileORM)
        .filter(EpreuveFileORM.epreuve_id == epreuve_gratuite)
        .first()
    )
    assert cible is not None
    assert get_storage().exists(cible.storage_key)
    r = admin.delete(f"/api/admin/sauvegardes/{cible.storage_key}")
    assert r.status_code == 400
    assert get_storage().exists(cible.storage_key), "le fichier doit être intact"


def test_suppression_inexistante(admin) -> None:
    r = admin.delete(f"/api/admin/sauvegardes/{PREFIXE}/2099-01-01T000000Z")
    assert r.status_code == 404


def test_sauvegarde_corrompue_absente_de_l_inventaire(admin, epreuve_gratuite) -> None:
    """Une sauvegarde dont l'index est cassé n'est PAS listée comme valide.

    L'afficher laisserait croire qu'on peut la restaurer ; c'est pire que de
    ne pas la montrer.
    """
    r = admin.post("/api/admin/sauvegardes/export", json={})
    _attendre(admin, r.json()["id"])
    cle = admin.get("/api/admin/sauvegardes").json()["sauvegardes"][0]["cle"]
    get_storage().put_bytes(f"{cle}/{NOM_INDEX}", b"{ ceci n'est pas du json")
    assert admin.get("/api/admin/sauvegardes").json()["sauvegardes"] == []


# --------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------


def test_liste_des_jobs(admin, epreuve_gratuite) -> None:
    """Les deux jobs créés ici sont les deux plus récents.

    La base est partagée entre les tests : on ne peut pas affirmer un nombre
    ABSOLU de jobs, seulement que les nôtres sont là, en tête de liste.
    """
    for _ in range(2):
        r = admin.post("/api/admin/sauvegardes/export", json={})
        _attendre(admin, r.json()["id"])
    r = admin.get("/api/admin/sauvegardes/jobs")
    assert r.status_code == 200, r.text
    jobs = r.json()["jobs"]
    assert len(jobs) >= 2
    assert all(j["kind"] == "export" and j["status"] == "done" for j in jobs[:2])
    # Le plus récent d'abord.
    assert jobs[0]["created_at"] >= jobs[1]["created_at"]


def test_job_inconnu_404(admin) -> None:
    assert admin.get("/api/admin/sauvegardes/jobs/nexiste-pas").status_code == 404


def test_journal_du_job_conserve(admin, epreuve_gratuite) -> None:
    r = admin.post("/api/admin/sauvegardes/export", json={})
    job = _attendre(admin, r.json()["id"])
    assert job["logs"], "le journal doit raconter ce qui s'est passé"
    assert any(isinstance(ligne, str) for ligne in job["logs"])
    assert isinstance(json.loads(json.dumps(job["report"])), dict)
