"""Service d'export de sauvegarde (Phase 2 du plan `PLAN_SAUVEGARDES.md`).

Les cas défendus ici sont ceux qui font la valeur d'une sauvegarde :

- le manifeste porte TOUTES les colonnes, y compris celles que l'import
  heuristique jette (``statut`` publié, durée, coefficient, gratuit, plusieurs
  sujets) — sans quoi une restauration perdrait des données ;
- l'``epreuve_files.id`` est conservé, car le Markdown y pointe ;
- le découpage au-dessus du seuil produit des parties **autonomes** ;
- un objet absent du stockage est signalé, pas silencieusement sauté ;
- un octet altéré dans une partie est détecté.
"""
from __future__ import annotations

import io
import json
import zipfile

import pytest

from app.core import export_service
from app.core.export_service import (
    NOM_INDEX,
    NOM_LISEZMOI,
    NOM_MANIFESTE,
    NOM_SAUVEGARDE,
    build_manifest,
    run_export,
)
from app.core.storage import get_storage
from app.db_models import EpreuveFileORM


def _epreuve(
    db,
    annee: str,
    *,
    matiere: str = "Mathématiques",
    statut: str = "publie",
    filieres=("D",),
) -> str:
    """Crée une épreuve publiée avec un sujet, par l'API d'administration."""
    from app.db import utc_now

    from app.db_models import EpreuveORM

    e = EpreuveORM(
        niveau="SECONDAIRE",
        classe="terminale",
        evaluation="BAC",
        matiere=matiere,
        annee=annee,
        duree="4h",
        coefficient="5",
        gratuit=True,
        statut=statut,
        extrait="extrait",
    )
    db.add(e)
    db.flush()
    for f in filieres:
        from app.db_models import EpreuveFiliereORM

        db.add(EpreuveFiliereORM(epreuve_id=e.id, filiere=f))
    # Le sujet porte une référence d'image : elle doit survivre au round-trip
    # par simple préservation de l'id de la ligne image.
    db.add(
        EpreuveFileORM(
            epreuve_id=e.id,
            cible="sujet",
            format="md",
            sujet_index=0,
            filename="sujet.md",
            storage_key=f"epreuves/SECONDAIRE/{annee}/{e.id}/sujet.md",
            mime_type="text/markdown; charset=utf-8",
            size_bytes=0,
            checksum_sha256="",
        )
    )
    db.add(
        EpreuveFileORM(
            epreuve_id=e.id,
            cible="sujet",
            format="image",
            sujet_index=0,
            filename="figure.png",
            storage_key=f"epreuves/SECONDAIRE/{annee}/{e.id}/sujet-figure.png",
            mime_type="image/png",
            size_bytes=0,
            checksum_sha256="",
            width=8,
            height=8,
        )
    )
    db.commit()
    return e.id


def _remplir_stockage(db, contenu_sujets: str = "# Sujet\n\n![f](figure.png)\n") -> None:
    """Écrit les objets réels et aligne `size_bytes` / `checksum_sha256`."""
    import hashlib

    stockage = get_storage()
    for f in db.query(EpreuveFileORM).all():
        data = (
            contenu_sujets.encode("utf-8")
            if f.format == "md"
            else bytes([(i * 7) % 256 for i in range(64)])
        )
        stockage.put_stream(f.storage_key, [data], mime_type=f.mime_type)
        f.size_bytes = len(data)
        f.checksum_sha256 = hashlib.sha256(data).hexdigest()
    db.commit()


@pytest.fixture()
def db_prete(client):
    """Session sur une base dont les tables existent ET dont le catalogue est
    vide.

    Le lifespan (fixture `client`) crée les tables, comme partout ailleurs dans
    la suite. La purge est spécifique à ce fichier : la base de test est
    partagée entre tous les tests du projet, donc sans elle un export verrait
    les épreuves des tests précédents — et une image supprimée par un autre
    test apparaîtrait comme « absente », faussant les assertions d'intégrité.
    Les tests de ce fichier ne dépendent que de ce qu'ils créent eux-mêmes.
    """
    from app.db import SessionLocal

    from conftest import purger_catalogue

    session = SessionLocal()
    try:
        purger_catalogue(session)
        yield session
    finally:
        session.close()


@pytest.fixture()
def sauvegarde(db_prete, tmp_path):
    """Une épreuve, ses objets en stockage, puis l'export. Renvoie
    `(destination, rapport, storage)`."""
    _epreuve(db_prete, "2001")
    _remplir_stockage(db_prete)
    dest = "_sauvegardes/test"
    rapport = run_export(db_prete, dest, dossier_tmp=tmp_path)
    return dest, rapport, get_storage()


# --------------------------------------------------------------------------
# Manifeste
# --------------------------------------------------------------------------


def test_manifeste_conserve_les_colonnes_perdues_par_import(db_prete) -> None:
    """Le cœur du correctif : ce que l'import jette, l'export doit garder."""
    eid = _epreuve(db_prete, "2101")
    m = build_manifest(db_prete, "2026-09-27T00:00:00")
    e = next(x for x in m["epreuves"] if x["id"] == eid)
    assert e["statut"] == "publie"
    assert e["duree"] == "4h"
    assert e["coefficient"] == "5"
    assert e["gratuit"] is True
    assert e["extrait"] == "extrait"
    assert e["filieres"] == ["D"]
    assert m["format"] == "bacprep-export"
    assert m["version"] == 1


def test_manifeste_conserve_sujets_multiples(db_prete) -> None:
    """`sujet_index` > 0 : la structure multi-sujet, aplatie par l'import."""
    from app.db_models import EpreuveFileORM

    eid = _epreuve(db_prete, "2102")
    db_prete.add(
        EpreuveFileORM(
            epreuve_id=eid,
            cible="sujet",
            format="md",
            sujet_index=1,
            filename="sujet_1.md",
            storage_key=f"epreuves/SECONDAIRE/2102/{eid}/sujet_1.md",
            mime_type="text/markdown; charset=utf-8",
            size_bytes=5,
            checksum_sha256="x" * 64,
        )
    )
    db_prete.commit()
    m = build_manifest(db_prete, "2026-09-27T00:00:00")
    e = next(x for x in m["epreuves"] if x["id"] == eid)
    index = {f["chemin"] for f in e["fichiers"]}
    assert "fichiers/{}/sujet_1.md".format(eid) in index


def test_manifeste_conserve_id_de_ligne_fichier(db_prete) -> None:
    """Les références `/api/files/{id}` du Markdown ne valent que si l'id de
    la ligne image est conservé."""
    _epreuve(db_prete, "2103")
    m = build_manifest(db_prete, "2026-09-27T00:00:00")
    image = next(
        f for e in m["epreuves"] for f in e["fichiers"] if f["format"] == "image"
    )
    reel = (
        db_prete.query(EpreuveFileORM)
        .filter(EpreuveFileORM.id == image["id"])
        .one()
    )
    assert reel.storage_key == image["storage_key"]


def test_manifeste_est_deterministe(db_prete) -> None:
    """Même état, même manifeste : sans cela le ré-export n'est pas comparable."""
    _epreuve(db_prete, "2104")
    a = build_manifest(db_prete, "T")
    b = build_manifest(db_prete, "T")
    assert json.dumps(a, sort_keys=False) == json.dumps(b, sort_keys=False)


# --------------------------------------------------------------------------
# Écriture
# --------------------------------------------------------------------------


def test_export_ecrit_manifeste_index_et_zip(db_prete, sauvegarde) -> None:
    dest, rapport, stockage = sauvegarde
    assert stockage.exists(f"{dest}/{NOM_MANIFESTE}")
    assert stockage.exists(f"{dest}/{NOM_INDEX}")
    assert stockage.exists(f"{dest}/{NOM_SAUVEGARDE}")
    assert rapport["parties"][0]["nom"] == NOM_SAUVEGARDE
    assert rapport["erreurs"] == []
    assert rapport["absents"] == []


def test_export_zip_est_une_archive_valide(db_prete, sauvegarde) -> None:
    dest, rapport, stockage = sauvegarde
    zf = zipfile.ZipFile(io.BytesIO(stockage.get_bytes(f"{dest}/{NOM_SAUVEGARDE}")))
    assert zf.testzip() is None
    noms = zf.namelist()
    assert any(n.endswith("/sujet.md") for n in noms)
    assert any(n.endswith("/sujet-figure.png") for n in noms)
    # Le contenu lu dans le ZIP est bien celui du stockage.
    sujet = next(n for n in noms if n.endswith("sujet.md"))
    assert zf.read(sujet).decode("utf-8").startswith("# Sujet")


def test_sha256_de_partie_dans_index(db_prete, sauvegarde) -> None:
    """L'index porte le hash de la partie : c'est lui qui permet de détecter
    une sauvegarde corrompue."""
    import hashlib

    dest, rapport, stockage = sauvegarde
    index = json.loads(stockage.get_bytes(f"{dest}/{NOM_INDEX}"))
    attendu = hashlib.sha256(stockage.get_bytes(f"{dest}/{NOM_SAUVEGARDE}")).hexdigest()
    assert index["parties"][0]["sha256"] == attendu
    assert index["parties"][0]["octets"] > 0


def test_decoupe_en_parties_autonomes(db_prete, tmp_path, monkeypatch) -> None:
    """Au-delà du seuil : des parties séparées, chacune relisible seule."""
    monkeypatch.setenv("SAUVEGARDE_SEUILLE_PARTIE_OCTETS", "1")
    monkeypatch.setenv("SAUVEGARDE_TAILLE_PARTIE_OCTETS", "64")
    for i in range(6):
        _epreuve(db_prete, f"22{i:02d}")
    _remplir_stockage(db_prete)

    dest = "_sauvegardes/parties"
    rapport = run_export(db_prete, dest, dossier_tmp=tmp_path)
    stockage = get_storage()
    noms = [p["nom"] for p in rapport["parties"]]
    assert len(noms) > 1
    assert noms == sorted(noms)
    assert noms[0] == "part-0001.zip"

    # Chaque partie est une archive AUTONOME et valide.
    total = 0
    for nom in noms:
        zf = zipfile.ZipFile(io.BytesIO(stockage.get_bytes(f"{dest}/{nom}")))
        assert zf.testzip() is None
        total += len(zf.namelist())

    # L'extraction de toutes les parties redonne le catalogue complet.
    attendu = db_prete.query(EpreuveFileORM).count()
    assert total == attendu


def test_objet_absent_signale_pas_crashe(db_prete, tmp_path) -> None:
    """Un objet perdu en stockage doit être DÉCLARÉ, pas silencieusement sauté :
    diagnostiquer la perte fait partie du rôle d'une sauvegarde."""
    _epreuve(db_prete, "2201")
    _remplir_stockage(db_prete)
    # On supprime un objet réel après coup.
    stockage = get_storage()
    victime = (
        db_prete.query(EpreuveFileORM).filter(EpreuveFileORM.format == "image").first()
    )
    stockage.delete(victime.storage_key)

    rapport = run_export(db_prete, "_sauvegardes/absent", dossier_tmp=tmp_path)
    assert len(rapport["absents"]) == 1
    assert rapport["absents"][0]["storage_key"] == victime.storage_key
    # Le reste est bien exporté, et le manifest reste fidèle à la base.
    assert rapport["parties"][0]["nb_fichiers"] == 1


def test_donnees_modifiees_signalees(db_prete, tmp_path) -> None:
    """Si l'objet ne correspond plus au checksum annoncé en base, l'écart est
    signalé — c'est exactement le symptôme d'un stockage dégradé."""
    import hashlib

    _epreuve(db_prete, "2202")
    _remplir_stockage(db_prete)
    fichier = db_prete.query(EpreuveFileORM).filter(EpreuveFileORM.format == "md").first()
    stockage = get_storage()
    stockage.put_stream(fichier.storage_key, [b"# Sujet MODIFIE\n"])
    db_prete.commit()

    rapport = run_export(db_prete, "_sauvegardes/incoherent", dossier_tmp=tmp_path)
    assert len(rapport["incoherences"]) == 1
    assert rapport["incoherences"][0]["calcule"] == hashlib.sha256(
        b"# Sujet MODIFIE\n"
    ).hexdigest()


def test_catalogue_vide_produit_une_sauvegarde_valide(db_prete, tmp_path) -> None:
    """Zéro épreuve : l'export doit encore produire une archive lisible, sinon
    une restauration « tout effacer » n'a rien à détecter."""
    dest = "_sauvegardes/vide"
    rapport = run_export(db_prete, dest, dossier_tmp=tmp_path)
    assert rapport["nb_fichiers"] == 0
    zf = zipfile.ZipFile(io.BytesIO(get_storage().get_bytes(f"{dest}/{NOM_SAUVEGARDE}")))
    assert zf.testzip() is None
    assert zf.namelist() == []


def test_pas_de_fichier_temporaire_residuel(db_prete, tmp_path) -> None:
    """Le disque doit être relâché : le temporaire d'une partie est supprimé."""
    _epreuve(db_prete, "2203")
    _remplir_stockage(db_prete)
    run_export(db_prete, "_sauvegardes/tmp", dossier_tmp=tmp_path)
    assert list(tmp_path.glob("*")) == []


def test_procedure_embarquee_avec_la_sauvegarde(db_prete, tmp_path) -> None:
    """La procédure de restauration voyage AVEC l'archive.

    Une sauvegarde dont on ne sait pas la relire n'est qu'un fichier .zip. Si
    le texte ne part pas avec les données, il reste dans le dépôt — où il ne
    sera pas au moment d'en avoir besoin, sur la machine qui récupère.
    """
    dest = "_sauvegardes/lisezmoi"
    run_export(db_prete, dest, dossier_tmp=tmp_path)
    stockage = get_storage()
    texte = stockage.get_bytes(f"{dest}/{NOM_LISEZMOI}").decode("utf-8")
    # Le contenu utile, pas seulement un fichier présent. On vérifie les
    # QUESTIONS auxquelles quelqu'un qui restaure doit pouvoir répondre —
    # « que va-t-il se passer », « dans quel mode », « qu'est-ce qui garantit
    # l'intégrité » — et non la présence d'un identifiant de fonction : le
    # contenu se lit, il ne se compile pas.
    assert "ESSAI À BLANC" in texte, "la procédure doit annoncer l'étape d'essai"
    assert "confirmation explicite" in texte, "l'écriture doit être annoncée comme conditionnelle"
    assert "SHA-256" in texte, "le contrôle d'intégrité doit être décrit"
    assert "bucket" in texte and "disaster" in texte, "les deux modes doivent être nommés"
    # Aucune commande de restauration en ligne de commande : elle contournerait
    # l'essai à blanc, donc l'étape qui annonce ce qui va être écrit. Une
    # procédure qui enseigne le contournement enseigne le danger.
    assert "python -c" not in texte and "run_restore" not in texte, (
        "la procédure ne doit pas ouvrir une voie de restauration hors interface"
    )


def test_progression_rapporte_des_compteurs(db_prete, tmp_path) -> None:
    """L'IHM a besoin de COMPTEURS, pas de messages à analyser.

    `on_progress` sert à l'affichage ; `progression` sert au pourcentage. Les
    deux sont vérifiés séparément pour qu'aucun ne dérive dans le vide.
    """
    _epreuve(db_prete, "2204")
    _remplir_stockage(db_prete)
    vu: list[tuple] = []
    run_export(
        db_prete,
        "_sauvegardes/progression",
        dossier_tmp=tmp_path,
        progression=lambda *args: vu.append(args),
    )
    assert vu, "la progression doit être appelée"
    # Premier point : 0 fichier fait, pour un total déjà connu.
    fichiers, total, parties, parties_total, octets = vu[0]
    assert (fichiers, parties, octets) == (0, 0, 0)
    assert total > 0
    # Dernier point : tout est fait, et le total est atteint.
    fichiers, total, parties, parties_total, octets = vu[-1]
    assert fichiers == total
    assert parties == parties_total
    assert octets > 0
