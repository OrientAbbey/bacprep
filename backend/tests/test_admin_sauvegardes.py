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
from app.db_models import EpreuveFileORM, EpreuveORM


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
    ne pas la montrer. Elle est en revanche SIGNALÉE dans `ignorees`, avec sa
    raison : sans cela, elle disparaîtrait silencieusement et l'administrateur
    croirait à une perte de données.
    """
    r = admin.post("/api/admin/sauvegardes/export", json={})
    _attendre(admin, r.json()["id"])
    inventaire = admin.get("/api/admin/sauvegardes").json()
    cle = inventaire["sauvegardes"][0]["cle"]
    get_storage().put_bytes(f"{cle}/{NOM_INDEX}", b"{ ceci n'est pas du json")
    inventaire = admin.get("/api/admin/sauvegardes").json()
    assert inventaire["sauvegardes"] == []
    ignorees = inventaire.get("ignorees") or []
    assert len(ignorees) == 1, ignorees
    assert ignorees[0]["cle"] == cle
    assert "illisible" in ignorees[0]["raison"].lower()


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


def _job_pending(admin, db, *, age_secondes: float, statut: str = "pending") -> str:
    """Insère un job à l'état voulu et ageing artificiallement.

    Un job que personne ne réclamera reste `pending` indéfiniment : le scénario
    se produit quand le service redémarre entre la réponse au POST et
    l'exécution de la tâche de fond. On simule l'ancienneté en écrivant
    directement `created_at`, plutôt qu'en attendant cinq minutes.
    """
    from datetime import timedelta

    from app.db import utc_now
    from app.db_models import SauvegardeJobORM

    job = SauvegardeJobORM(
        kind="export",
        status=statut,
        destination="_sauvegardes/jamais-demarre",
        created_at=utc_now() - timedelta(seconds=age_secondes),
    )
    db.add(job)
    db.commit()
    return job.id


def test_job_pending_ancien_passe_en_erreur(admin, db) -> None:
    """Un job en attente depuis plus de cinq minutes est signalé.

    L'alternative — le laisser en attente — condamne l'écran : le job
    n'atteindra jamais un état terminal, donc le suivi automatique
    l'interroge toutes les 1,5 s pour toujours, et la carte affiche « en
    cours » alors qu'aucun processus ne travaille.
    """
    from app.routers.admin_sauvegardes import _ATTENTE_MAX

    job_id = _job_pending(admin, db, age_secondes=_ATTENTE_MAX + 60)
    r = admin.get(f"/api/admin/sauvegardes/jobs/{job_id}")
    assert r.status_code == 200, r.text
    etat = r.json()
    assert etat["status"] == "error", "un job jamais repris doit être signalé, pas affiché en cours"
    # Le motif doit être lisible par un humain : « erreur » sans raison laisse
    # l'administrateur deviner.
    rapport = json.dumps(etat.get("report") or {}, ensure_ascii=False)
    assert "jamais démarré" in rapport.lower(), rapport


def test_job_pending_recent_nest_pas_touche(admin, db) -> None:
    """Un job lancé à l'instant est normal : le service peut prendre une
    demi-seconde pour l'exécuter. Le signaler serait un faux positif qui
    convince l'administrateur de relancer une sauvegarde déjà en cours.
    """
    job_id = _job_pending(admin, db, age_secondes=2)
    r = admin.get(f"/api/admin/sauvegardes/jobs/{job_id}")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "pending"


def test_job_running_ancien_nest_pas_touche(admin, db) -> None:
    """Un job `running` a le droit de durer.

    C'est la question qui décide de tout ici : un export lit des gigaoctets
    dans S3 et les recompresse. Juger qu'il est bloqué sur la seule foi de son
    âge reviendrait à declareer en erreur un travail qui aboutit — et à
    inviter à relancer une sauvegarde qui écrit déjà.
    """
    job_id = _job_pending(admin, db, age_secondes=24 * 3600, statut="running")
    r = admin.get(f"/api/admin/sauvegardes/jobs/{job_id}")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "running"


def test_age_du_job_tolere_les_deux_fuseaux() -> None:
    """`created_at` est naive sur SQLite, aware sur PostgreSQL.

    Mélanger un `datetime` aware et un naïf lève `TypeError` au moment de la
    soustraction — donc sur PostgreSQL, c'est-à-dire en production, et
    seulement là : la suite locale, sur SQLite, passerait sans rien voir. Ce
    test construit donc les DEUX formes et vérifie que l'âge calculé est le
    même, pour que la différence entre les moteurs ne soit pas découverte par
    un utilisateur.
    """
    from datetime import datetime, timedelta, timezone

    from app.routers.admin_sauvegardes import _naive

    maintenant = datetime.now(timezone.utc)
    decale = timedelta(seconds=600)
    formes = {
        "aware (PostgreSQL)": maintenant - decale,
        "naive (SQLite)": (maintenant - decale).replace(tzinfo=None),
    }
    ages = {}
    for nom, valeur in formes.items():
        # C'est exactement l'expression du calcul d'âge dans la route.
        ages[nom] = (_naive(maintenant) - _naive(valeur)).total_seconds()
    ecarts = set(ages.values())
    assert len(ecarts) == 1, f"l'âge dépend du moteur : {ages}"
    age = ecarts.pop()
    assert 595 <= age <= 605, f"âge inattendu : {age}"


def test_journal_du_job_conserve(admin, epreuve_gratuite) -> None:
    r = admin.post("/api/admin/sauvegardes/export", json={})
    job = _attendre(admin, r.json()["id"])
    assert job["logs"], "le journal doit raconter ce qui s'est passé"
    assert any(isinstance(ligne, str) for ligne in job["logs"])
    assert isinstance(json.loads(json.dumps(job["report"])), dict)


# --------------------------------------------------------------------------
# Durée, phase et complétude
# --------------------------------------------------------------------------


def test_export_expose_duree_et_phase(admin, epreuve_gratuite) -> None:
    """Un job terminé porte sa durée et sa phase finale.

    Sans `duration_ms`, l'écran ne peut afficher que l'heure de la demande :
    elle ne dit rien du temps de travail réel et donne une durée fausse dès
    qu'un job a attendu son tour.
    """
    r = admin.post("/api/admin/sauvegardes/export", json={})
    job = _attendre(admin, r.json()["id"])
    assert job["status"] == "done", job
    assert job["started_at"], "la prise en charge doit être datée"
    assert job["finished_at"], "la fin doit être datée"
    assert isinstance(job["duration_ms"], int)
    assert job["duration_ms"] >= 0
    assert job["phase"], "la phase finale doit être exposée"
    assert job["heartbeat_at"], "le dernier battement doit être exposé"


def test_restauration_expose_duree_et_phase(admin, sauvegarde) -> None:
    r = admin.post(
        "/api/admin/sauvegardes/restore",
        json={"source": sauvegarde["cle"], "mode": "bucket"},
    )
    assert r.status_code == 200, r.text
    job = _attendre(admin, r.json()["id"])
    assert job["status"] == "done", job
    assert isinstance(job["duration_ms"], int)
    assert job["phase"], "une restauration doit annoncer sa phase"


def test_marqueur_pret_ecrit_apres_index(admin, epreuve_gratuite) -> None:
    """`_READY` n'existe qu'une fois l'export terminé.

    C'est ce marqueur qui distingue une sauvegarde complète d'une archive
    interrompue : sa présence prouve que l'index a été écrit avant lui.
    """
    from app.core.export_service import NOM_PRET

    r = admin.post("/api/admin/sauvegardes/export", json={})
    job = _attendre(admin, r.json()["id"])
    assert job["status"] == "done", job
    inventaire = admin.get("/api/admin/sauvegardes").json()
    cle = inventaire["sauvegardes"][0]["cle"]
    assert get_storage().exists(f"{cle}/{NOM_PRET}")


def test_export_en_cours_absent_de_l_inventaire(admin, db, epreuve_gratuite) -> None:
    """Un dossier d'export actif n'est pas proposé à la restauration.

    Le job est simulé `running` : sans cette règle, l'inventaire listerait une
    archive partielle comme restaurable, et la restauration échouerait sur une
    partie manquante au lieu de l'empêcher.
    """
    from app.core.export_service import NOM_INDEX, NOM_MANIFESTE
    from app.db_models import SauvegardeJobORM

    prefixe = f"{PREFIXE}/2026-01-01T000000Z"
    stockage = get_storage()
    stockage.put_bytes(
        f"{prefixe}/{NOM_MANIFESTE}",
        json.dumps({"epreuve_count": 0, "fichier_count": 0}).encode("utf-8"),
    )
    stockage.put_bytes(
        f"{prefixe}/{NOM_INDEX}",
        json.dumps({"parties": []}).encode("utf-8"),
    )
    db.add(
        SauvegardeJobORM(
            kind="export",
            status="running",
            destination=prefixe,
        )
    )
    db.commit()

    inventaire = admin.get("/api/admin/sauvegardes").json()
    assert all(s["cle"] != prefixe for s in inventaire["sauvegardes"])
    ignorees = {i["cle"]: i["raison"] for i in inventaire.get("ignorees") or []}
    assert prefixe in ignorees, ignorees
    assert "cours" in ignorees[prefixe].lower()


def test_ancienne_sauvegarde_sans_marqueur_reste_listee(admin, db, epreuve_gratuite) -> None:
    """Une sauvegarde antérieure à `_READY` reste restaurable.

    La compatibilité est la raison d'être de la règle : refuser toutes les
    archives existantes au déploiement de l'instrumentation reviendrait à
    supprimer les sauvegardes de la veille.
    """
    from app.core.export_service import NOM_INDEX, NOM_MANIFESTE

    prefixe = f"{PREFIXE}/2025-12-31T235959Z"
    stockage = get_storage()
    stockage.put_bytes(
        f"{prefixe}/{NOM_MANIFESTE}",
        json.dumps({"epreuve_count": 1, "fichier_count": 2}).encode("utf-8"),
    )
    stockage.put_bytes(
        f"{prefixe}/{NOM_INDEX}",
        json.dumps({"parties": [{"nom": "partie-1.zip", "octets": 10, "sha256": "a"}]}).encode(
            "utf-8"
        ),
    )

    inventaire = admin.get("/api/admin/sauvegardes").json()
    assert any(s["cle"] == prefixe for s in inventaire["sauvegardes"]), inventaire


def test_sauvegarde_recente_sans_marqueur_ignoree(admin, epreuve_gratuite) -> None:
    """Une sauvegarde récente sans `_READY` n'est pas proposée à la restauration.

    La tolérance historique ne doit pas devenir un trou permanent : à partir de
    `READY_OBLIGATOIRE_DEPUIS`, une archive sans marqueur final est incomplète,
    même si son index et son manifeste sont lisibles.
    """
    from app.core.export_service import NOM_INDEX, NOM_MANIFESTE

    prefixe = f"{PREFIXE}/2026-11-20T120000Z"
    stockage = get_storage()
    stockage.put_bytes(
        f"{prefixe}/{NOM_MANIFESTE}",
        json.dumps({"epreuve_count": 1, "fichier_count": 2}).encode("utf-8"),
    )
    stockage.put_bytes(
        f"{prefixe}/{NOM_INDEX}",
        json.dumps({"parties": [{"nom": "partie-1.zip", "octets": 10, "sha256": "a"}]}).encode("utf-8"),
    )

    inventaire = admin.get("/api/admin/sauvegardes").json()
    ignoree = next((i for i in inventaire["ignorees"] if i["cle"] == prefixe), None)
    assert ignoree is not None, inventaire
    assert "_READY" in ignoree["raison"]
    assert all(s["cle"] != prefixe for s in inventaire["sauvegardes"])


def test_manifeste_absent_signale_dans_les_ignorees(admin, epreuve_gratuite) -> None:
    """Un index seul ne fait pas une sauvegarde : le manifeste est requis.

    C'est le cas exact d'un export interrompu entre l'écriture des parties et
    celle du manifeste. Le dossier doit être signalé, pas listé comme valide.
    """
    from app.core.export_service import NOM_INDEX

    prefixe = f"{PREFIXE}/2026-02-01T000000Z"
    get_storage().put_bytes(
        f"{prefixe}/{NOM_INDEX}",
        json.dumps({"parties": []}).encode("utf-8"),
    )
    inventaire = admin.get("/api/admin/sauvegardes").json()
    assert all(s["cle"] != prefixe for s in inventaire["sauvegardes"])
    ignorees = {i["cle"]: i["raison"] for i in inventaire.get("ignorees") or []}
    assert prefixe in ignorees, ignorees
    assert "introuvable" in ignorees[prefixe].lower()


def test_index_absent_signale_dans_les_ignorees(admin, epreuve_gratuite) -> None:
    """Le manifeste seul ne suffit pas : l'index porte les empreintes.

    C'est l'état d'un export interrompu juste avant l'écriture de l'index. La
    sauvegarde est incomplète et doit être signalée, jamais proposée.
    """
    from app.core.export_service import NOM_MANIFESTE

    prefixe = f"{PREFIXE}/2026-02-02T000000Z"
    get_storage().put_bytes(
        f"{prefixe}/{NOM_MANIFESTE}",
        json.dumps({"epreuve_count": 0, "fichier_count": 0}).encode("utf-8"),
    )
    inventaire = admin.get("/api/admin/sauvegardes").json()
    assert all(s["cle"] != prefixe for s in inventaire["sauvegardes"])
    ignorees = {i["cle"]: i["raison"] for i in inventaire.get("ignorees") or []}
    assert prefixe in ignorees, ignorees
    assert "introuvable" in ignorees[prefixe].lower()



def test_panne_de_stockage_renvoie_503(admin, monkeypatch) -> None:
    """Un stockage injoignable n'est PAS « aucune sauvegarde ».

    Répondre une liste vide ferait croire à une perte de données et pousserait
    à relancer un export. Le statut distinct permet à l'écran de dire la vérité.
    """
    from app.routers import admin_sauvegardes as route

    class StockageEnPanne:
        def list_objects(self, _prefixe):
            raise RuntimeError("S3 injoignable")

    monkeypatch.setattr(route, "get_storage", lambda: StockageEnPanne())
    r = admin.get("/api/admin/sauvegardes")
    assert r.status_code == 503, r.text
    assert "stockage" in r.json()["detail"].lower()


def test_session_admin_expiree_pendant_inventaire_401_pas_503(admin, monkeypatch) -> None:
    """Une session expirée pendant le chargement de l'inventaire est une 401,
    pas une panne de stockage (503).

    La vérification de la session doit précéder tout accès au stockage :
    sinon l'écran afficherait « stockage momentanément indisponible » alors
    que la seule cause est le verrou admin expiré — deux messages qui
    n'appellent pas du tout la même réaction.
    """
    from datetime import timedelta

    from app.core import admin_session
    from app.core.admin_session import session_timeout
    from app.db import SessionLocal, utc_now
    from app.db_models import AdminLockORM
    from app.routers import admin_sauvegardes as route

    appels_stockage: list[int] = []

    def stockage_interdit():
        appels_stockage.append(1)
        raise AssertionError("Le stockage ne doit pas être interrogé avec une session expirée")

    monkeypatch.setattr(route, "get_storage", stockage_interdit)

    with SessionLocal() as db:
        lock = db.query(AdminLockORM).filter(AdminLockORM.id == admin_session.LOCK_ID).one()
        lock.last_activity = utc_now() - session_timeout() - timedelta(minutes=1)
        db.commit()

    r = admin.get("/api/admin/sauvegardes")
    assert r.status_code == 401, r.text
    assert "Session admin invalide ou expirée" in r.json()["detail"]
    assert appels_stockage == []


def test_echec_export_conserve_duree_et_phase(admin, epreuve_gratuite, monkeypatch) -> None:
    """Un export en échec garde sa durée et la phase atteinte.

    Sans cela, l'écran afficherait « échec » sans dire combien de temps a été
    perdu ni à quelle étape — deux informations nécessaires pour décider s'il
    faut relancer ou changer de stratégie.
    """
    from app.core import export_service

    def echec(*_args, **_kwargs):
        raise RuntimeError("panne simulée")

    monkeypatch.setattr(export_service, "run_export", echec)
    r = admin.post("/api/admin/sauvegardes/export", json={})
    job = _attendre(admin, r.json()["id"])
    assert job["status"] == "error", job
    assert isinstance(job["duration_ms"], int)
    assert job["started_at"] and job["finished_at"]
    assert job["phase"], "la phase atteinte doit rester lisible après l'échec"
