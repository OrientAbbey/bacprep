"""Restauration de sauvegarde (Phase 4 du plan `PLAN_SAUVEGARDES.md`).

`test_round_trip_fidele` est le test capital du projet : sans égalité stricte
des manifestes après aller-retour, l'outil ne fait pas son travail. Les autres
tests défendent les propriétés de sécurité (manifeste hostile, base non vide,
corruption) et d'exploitation (idempotence, reprise).
"""
from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

import pytest

from app.core.export_service import NOM_INDEX, NOM_MANIFESTE, run_export
from app.core.restore_service import (
    MODE_BUCKET,
    MODE_DISASTER,
    ManifesteInvalide,
    run_restore,
    valider_manifeste,
)
from app.core.storage import get_storage
from app.db_models import EpreuveFileORM, EpreuveFiliereORM, EpreuveORM


def _reinitialiser(db) -> None:
    """Vide le catalogue. Délègue à la purge partagée : une liste de tables
    écrite à la main devient fausse dès qu'une table vient à référencer
    `epreuves` — et l'échec apparaît alors dans un autre fichier de tests."""
    from conftest import purger_catalogue

    purger_catalogue(db)


def _detruire_objets(db) -> None:
    """Supprime les objets de stockage des épreuves présentes en base.

    CIBLE LES CLÉS CONNUES : un `rglob` sur la racine du stockage effacerait
    aussi les objets des autres tests de la suite, qui partagent le même
    backend local.
    """
    stockage = get_storage()
    for fichier in db.query(EpreuveFileORM).all():
        stockage.delete(fichier.storage_key)
    db.commit()


def _catalogue(db, prefixe: str = "2301") -> str:
    """Un catalogue « réaliste » : publié, plusieurs sujets, deux filières, et
    une image RÉFÉRENCÉE par son URL contrôlée.

    L'image est créée AVANT le sujet, pour que le Markdown contienne un vrai
    `/api/files/{id}`. Sans cela, la propriété centrale de l'outil — les
    identifiants préservés gardent les références valides — ne serait pas
    réellement testée.
    """
    from app.core import epreuve_files

    e = EpreuveORM(
        niveau="SECONDAIRE",
        classe="terminale",
        evaluation="BAC",
        matiere="Mathématiques",
        annee=prefixe,
        duree="4h",
        coefficient="5",
        gratuit=True,
        statut="publie",
        extrait="Un extrait de sujet",
    )
    db.add(e)
    db.flush()
    eid = e.id
    db.add(EpreuveFiliereORM(epreuve_id=eid, filiere="D"))
    db.add(EpreuveFiliereORM(epreuve_id=eid, filiere="C"))

    stockage = get_storage()
    octets = b"\x89PNG" + bytes(range(64))
    cle_image = epreuve_files.image_key(e, "sujet", "figure.png")
    stockage.put_stream(cle_image, [octets], mime_type="image/png")
    image = EpreuveFileORM(
        epreuve_id=eid,
        cible="sujet",
        format="image",
        sujet_index=0,
        filename="figure.png",
        storage_key=cle_image,
        mime_type="image/png",
        size_bytes=len(octets),
        width=8,
        height=8,
        checksum_sha256=epreuve_files.sha256_hex(octets),
    )
    db.add(image)
    db.flush()

    contenu = {
        ("sujet", 0): f"# Sujet\n\n![figure](/api/files/{image.id})\n\n## Question 1\n2 + 2 = ?\n",
        ("corrige", 0): f"# Corrigé\n\nVoir ![figure](/api/files/{image.id}).\n",
        # Sujet supplémentaire : la structure que l'import heuristique écrase.
        ("sujet", 1): "# Sujet 2\n\nDeuxième partie.\n",
    }
    for (cible, index), texte in contenu.items():
        data = texte.encode("utf-8")
        cle = epreuve_files.document_key(e, cible, index)
        stockage.put_stream(cle, [data], mime_type="text/markdown; charset=utf-8")
        db.add(
            EpreuveFileORM(
                epreuve_id=eid,
                cible=cible,
                format="md",
                sujet_index=index,
                filename=cle.rsplit("/", 1)[-1],
                storage_key=cle,
                mime_type="text/markdown; charset=utf-8",
                size_bytes=len(data),
                checksum_sha256=epreuve_files.sha256_hex(data),
            )
        )
    db.commit()
    return eid


@pytest.fixture()
def db_prete(client):
    from app.db import SessionLocal

    session = SessionLocal()
    try:
        _reinitialiser(session)
        yield session
    finally:
        session.close()


@pytest.fixture()
def sauvegarde_exportee(db_prete, tmp_path):
    """Catalogue rempli, puis export. Renvoie le préfixe de stockage."""
    _catalogue(db_prete)
    dest = "_sauvegardes/DR"
    run_export(db_prete, dest, dossier_tmp=tmp_path)
    return dest


def _telecharger(dest: str, dossier: Path) -> Path:
    """Recopie une sauvegarde du stockage dans un dossier local, comme le fait
    l'opérateur sur une instance neuve."""
    stockage = get_storage()
    dossier.mkdir(parents=True, exist_ok=True)
    for nom in (NOM_MANIFESTE, NOM_INDEX):
        (dossier / nom).write_bytes(stockage.get_bytes(f"{dest}/{nom}"))
    index = json.loads((dossier / NOM_INDEX).read_text(encoding="utf-8"))
    for partie in index["parties"]:
        (dossier / partie["nom"]).write_bytes(
            stockage.get_bytes(f"{dest}/{partie['nom']}")
        )
    return dossier


# --------------------------------------------------------------------------
# Le test capital
# --------------------------------------------------------------------------


def test_round_trip_fidele(db_prete, tmp_path) -> None:
    """Export → restauration complète → ré-export : manifestes IDENTIQUES.

    C'est la propriété qui justifie tout l'outil. Elle ne peut tenir que si les
    identifiants de ligne sont préservés : les références `/api/files/{id}` du
    Markdown pointent dessus, et les colonnes ignorées par l'import
    (`statut`, `duree`, multi-sujets) sont rejouées telles quelles.
    """
    eid = _catalogue(db_prete, "2401")
    attendu = db_prete.query(EpreuveFileORM).count()
    avant = run_export(db_prete, "_sauvegardes/A", dossier_tmp=tmp_path)
    assert avant["erreurs"] == [] and avant["absents"] == []
    assert avant["incoherences"] == []
    assert avant["nb_fichiers"] == attendu

    # On simule la perte totale : plus aucun objet, plus aucune ligne.
    _telecharger("_sauvegardes/A", tmp_path / "copie")
    _detruire_objets(db_prete)
    _reinitialiser(db_prete)

    rapport = run_restore(
        db_prete,
        str(tmp_path / "copie"),
        mode=MODE_DISASTER,
        dry_run=False,
        confirmation_recue=True,
        dossier_tmp=tmp_path / "tva",
    )
    assert rapport["erreurs"] == [], rapport["erreurs"]
    assert rapport["incoherences"] == [], rapport["incoherences"]
    assert rapport["introuvables"] == []
    assert rapport["ecrits"] == attendu
    assert db_prete.query(EpreuveORM).one().id == eid

    apres = run_export(db_prete, "_sauvegardes/B", dossier_tmp=tmp_path)

    def manifeste(direction):
        return json.loads(
            get_storage()
            .get_bytes(f"{direction}/{NOM_MANIFESTE}")
            .decode("utf-8")
        )

    a, b = manifeste("_sauvegardes/A"), manifeste("_sauvegardes/B")
    a.pop("exporte_le"), b.pop("exporte_le")
    assert a == b, "l'aller-retour n'est pas fidèle"


def test_restitue_les_colonnes_et_les_ids(db_prete, tmp_path) -> None:
    """Vérifications lisibles, une par une, plutôt qu'une seule égalité globale."""
    eid = _catalogue(db_prete, "2402")
    identifiant_image = (
        db_prete.query(EpreuveFileORM)
        .filter(EpreuveFileORM.format == "image")
        .one()
        .id
    )
    run_export(db_prete, "_sauvegardes/C", dossier_tmp=tmp_path)
    _telecharger("_sauvegardes/C", tmp_path / "copie")
    _detruire_objets(db_prete)
    _reinitialiser(db_prete)
    run_restore(
        db_prete,
        str(tmp_path / "copie"),
        mode=MODE_DISASTER,
        dry_run=False,
        confirmation_recue=True,
        dossier_tmp=tmp_path / "tva",
    )

    e = db_prete.query(EpreuveORM).one()
    assert e.id == eid
    assert e.statut == "publie"
    assert e.duree == "4h"
    assert e.coefficient == "5"
    assert e.gratuit is True
    assert e.extrait == "Un extrait de sujet"
    assert sorted(e.filieres) == ["C", "D"]

    docs = {
        (f.cible, f.sujet_index): f
        for f in db_prete.query(EpreuveFileORM).filter(EpreuveFileORM.format == "md").all()
    }
    assert set(docs) == {("sujet", 0), ("sujet", 1), ("corrige", 0)}

    image = db_prete.query(EpreuveFileORM).filter(EpreuveFileORM.format == "image").one()
    assert image.id == identifiant_image, "l'id de ligne doit survivre"
    assert image.width == 8 and image.height == 8

    # Et surtout : le Markdown restore référence une image qui existe.
    sujet = get_storage().get_bytes(docs[("sujet", 0)].storage_key).decode("utf-8")
    assert "/api/files/" in sujet
    assert get_storage().exists(image.storage_key)


# --------------------------------------------------------------------------
# Propriétés de sécurité
# --------------------------------------------------------------------------


def test_manifeste_hostile_rejete(db_prete) -> None:
    """Un manifeste fabriqué ne doit jamais pouvoir écrire hors du stockage."""
    base = {
        "format": "bacprep-export",
        "version": 1,
        "epreuves": [
            {
                "id": "x",
                "niveau": "SECONDAIRE",
                "classe": "terminale",
                "evaluation": "BAC",
                "matiere": "Maths",
                "annee": "2024",
                "filieres": [],
                "fichiers": [
                    {
                        "id": "f",
                        "cible": "sujet",
                        "format": "md",
                        "filename": "s.md",
                        "chemin": "fichiers/x/s.md",
                        "storage_key": "epreuves/x/s.md",
                        "size_bytes": 0,
                    }
                ],
            }
        ],
    }
    valider_manifeste(base)  # la base valide passe

    cas = [
        {"format": "autre-chose"},
        {"version": 99},
        {"epreuves": "pas une liste"},
    ]
    for surcouche in cas:
        with pytest.raises(ManifesteInvalide):
            valider_manifeste({**base, **surcouche})

    chemins_malveillants = [
        "../../evasion.md",
        "/etc/passwd",
        "C:/Windows/system32",
        "a\\b.md",
        "fichiers/./x.md",
        "",
    ]
    for chemin in chemins_malveillants:
        casse = json.loads(json.dumps(base))
        casse["epreuves"][0]["fichiers"][0]["chemin"] = chemin
        with pytest.raises(ManifesteInvalide):
            valider_manifeste(casse)

    for cle in ["../evasion", "/absolu", "a/../../b"]:
        casse = json.loads(json.dumps(base))
        casse["epreuves"][0]["fichiers"][0]["storage_key"] = cle
        with pytest.raises(ManifesteInvalide):
            valider_manifeste(casse)


def test_disaster_refuse_une_base_pleine(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """Le mode complet refuse un catalogue existant : aucun contournement."""
    assert db_prete.query(EpreuveORM).count() == 1
    _telecharger(sauvegarde_exportee, tmp_path / "copie")
    with pytest.raises(ManifesteInvalide, match="déjà"):
        run_restore(
            db_prete,
            str(tmp_path / "copie"),
            mode=MODE_DISASTER,
            dry_run=False,
            confirmation_recue=True,
            dossier_tmp=tmp_path / "tva",
        )
    assert db_prete.query(EpreuveORM).count() == 1


def test_ecriture_sans_confirmation_refusee(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """Le verrou d'écriture par défaut doit tenir : sans confirmation reçue,
    l'appel est refusé AVANT tout accès au stockage."""
    _telecharger(sauvegarde_exportee, tmp_path / "copie")
    _detruire_objets(db_prete)
    with pytest.raises(ManifesteInvalide, match="confirmation"):
        run_restore(
            db_prete,
            str(tmp_path / "copie"),
            mode=MODE_BUCKET,
            dry_run=False,
            dossier_tmp=tmp_path / "tva",
        )
    # Rien n'a été réécrit.
    for fichier in db_prete.query(EpreuveFileORM).all():
        assert not get_storage().exists(fichier.storage_key)


def test_mode_inconnu_refuse(db_prete, sauvegarde_exportee) -> None:
    with pytest.raises(ManifesteInvalide):
        run_restore(db_prete, "_sauvegardes/DR", mode="jeter-tout")


# --------------------------------------------------------------------------
# Corruption et intégrité
# --------------------------------------------------------------------------


def test_partie_corrompue_detectee(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """Un octet altéré dans une partie : rien n'est restauré, et c'est signalé."""
    copie = _telecharger(sauvegarde_exportee, tmp_path / "copie")
    index = json.loads((copie / NOM_INDEX).read_text(encoding="utf-8"))
    partie = copie / index["parties"][0]["nom"]
    octets = bytearray(partie.read_bytes())
    # Un octet au milieu du contenu compressé.
    octets[len(octets) // 2] ^= 0xFF
    partie.write_bytes(bytes(octets))

    _detruire_objets(db_prete)
    _reinitialiser(db_prete)
    rapport = run_restore(
        db_prete,
        str(copie),
        mode=MODE_DISASTER,
        dry_run=False,
        confirmation_recue=True,
        dossier_tmp=tmp_path / "tva",
    )
    assert len(rapport["corrompues"]) == 1
    assert rapport["ecrits"] == 0
    # Et surtout : AUCUNE ligne créée, sinon le catalogue afficherait des
    # documents que le stockage ne contient pas.
    assert db_prete.query(EpreuveORM).count() == 0
    assert db_prete.query(EpreuveFileORM).count() == 0


def test_index_absent_refuse(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """Sans inventaire, une sauvegarde n'est pas exploitable : refus net.

    Accepter un dossier de ZIP sans `index.json` laisserait passer une
    sauvegarde tronquée — exactement l'incident que l'outil doit attraper.
    """
    copie = _telecharger(sauvegarde_exportee, tmp_path / "copie")
    (copie / NOM_INDEX).unlink()
    with pytest.raises(ManifesteInvalide, match=NOM_INDEX):
        run_restore(db_prete, str(copie), mode=MODE_BUCKET, dossier_tmp=tmp_path / "tva")


def test_index_sans_hash_refuse(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """Un index sans SHA-256 ne permet pas de juger de l'intégrité."""
    copie = _telecharger(sauvegarde_exportee, tmp_path / "copie")
    index = json.loads((copie / NOM_INDEX).read_text(encoding="utf-8"))
    index["parties"][0]["sha256"] = "trop-court"
    (copie / NOM_INDEX).write_text(json.dumps(index), encoding="utf-8")
    with pytest.raises(ManifesteInvalide, match="SHA-256"):
        run_restore(db_prete, str(copie), mode=MODE_BUCKET, dossier_tmp=tmp_path / "tva")


def test_partie_annoncee_absente_refusee(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """L'index annonce une partie que le dossier ne contient pas : on refuse,
    plutôt que de « restaurer » une sauvegarde à moitié."""
    copie = _telecharger(sauvegarde_exportee, tmp_path / "copie")
    index = json.loads((copie / NOM_INDEX).read_text(encoding="utf-8"))
    index["parties"].append({"nom": "partie-9999.zip", "sha256": "0" * 64})
    (copie / NOM_INDEX).write_text(json.dumps(index), encoding="utf-8")
    with pytest.raises(ManifesteInvalide, match="absente"):
        run_restore(db_prete, str(copie), mode=MODE_BUCKET, dossier_tmp=tmp_path / "tva")


def test_entree_dupliquee_refusee(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """Deux entrées de même nom dans une partie : ambiguïté, on n'écrit rien.

    C'est le vecteur classique de « zip smuggling » : deux lecteurs
    interpréteraient la partie différemment. Deviner laquelle est la bonne serait
    faux.
    """
    copie = _telecharger(sauvegarde_exportee, tmp_path / "copie")
    index = json.loads((copie / NOM_INDEX).read_text(encoding="utf-8"))
    manifest = json.loads((copie / NOM_MANIFESTE).read_text(encoding="utf-8"))
    eid = manifest["epreuves"][0]["id"]
    partie = copie / index["parties"][0]["nom"]
    with zipfile.ZipFile(partie, "a") as zf:
        zf.writestr(f"fichiers/{eid}/sujet.md", "# Sujet MODIFIE\n")

    # La partie reste valide (on régénère son hash) : c'est la DUPLICATION qui
    # doit être refusée, pas l'intégrité de l'archive.
    index["parties"][0]["sha256"] = hashlib.sha256(partie.read_bytes()).hexdigest()
    (copie / NOM_INDEX).write_text(json.dumps(index), encoding="utf-8")

    _detruire_objets(db_prete)
    _reinitialiser(db_prete)
    rapport = run_restore(
        db_prete,
        str(copie),
        mode=MODE_DISASTER,
        dry_run=False,
        confirmation_recue=True,
        dossier_tmp=tmp_path / "tva",
    )
    assert any("dupliqu" in e.get("erreur", "") for e in rapport["erreurs"])
    # La partie est abandonnée ENTIÈRE : aucun objet écrit, aucune métadonnée.
    assert rapport["ecrits"] == 0
    assert len(rapport["introuvables"]) > 0
    assert db_prete.query(EpreuveFileORM).count() == 0
    assert db_prete.query(EpreuveORM).count() == 0


def test_fichier_corrompu_non_ecrit(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """Un contenu qui ne correspond plus au checksum n'est PAS écrit.

    La PARTIE est refaite et réindexée pour rester cohérente : on veut isoler le
    contrôle du fichier, pas celui de la partie.
    """
    copie = _telecharger(sauvegarde_exportee, tmp_path / "copie")
    index = json.loads((copie / NOM_INDEX).read_text(encoding="utf-8"))
    manifest = json.loads((copie / NOM_MANIFESTE).read_text(encoding="utf-8"))
    eid = manifest["epreuves"][0]["id"]
    partie = copie / index["parties"][0]["nom"]

    # On reconstruit la partie en modifiant le contenu d'un seul fichier.
    with zipfile.ZipFile(partie) as zf:
        entrees = {i.filename: zf.read(i) for i in zf.infolist()}
    cible = f"fichiers/{eid}/sujet.md"
    assert cible in entrees
    entrees[cible] = b"# Sujet MODIFIE\n"
    with zipfile.ZipFile(partie, "w", zipfile.ZIP_DEFLATED) as zf:
        for nom, contenu in entrees.items():
            zf.writestr(nom, contenu)
    index["parties"][0]["sha256"] = hashlib.sha256(partie.read_bytes()).hexdigest()
    (copie / NOM_INDEX).write_text(json.dumps(index), encoding="utf-8")

    _detruire_objets(db_prete)
    _reinitialiser(db_prete)
    rapport = run_restore(
        db_prete,
        str(copie),
        mode=MODE_DISASTER,
        dry_run=False,
        confirmation_recue=True,
        dossier_tmp=tmp_path / "tva",
    )
    assert len(rapport["incoherences"]) == 1
    assert rapport["incoherences"][0]["fichier"].endswith("sujet.md")
    # Le fichier fautif n'a pas été écrit, les autres si.
    stockage = get_storage()
    epreuve = manifest["epreuves"][0]
    fautif = next(f for f in epreuve["fichiers"] if f["chemin"] == cible)
    autres = [f for f in epreuve["fichiers"] if f["chemin"] != cible]
    assert not stockage.exists(fautif["storage_key"])
    assert all(stockage.exists(f["storage_key"]) for f in autres)
    # Restauration incomplète : la base n'est surtout pas rejouée.
    assert db_prete.query(EpreuveORM).count() == 0


# --------------------------------------------------------------------------
# Idempotence et reprise
# --------------------------------------------------------------------------


def test_dry_run_necrit_rien(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """`dry_run` est le DÉFAUT et ne doit toucher à rien.

    On commence par perte des objets : c'est le seul état où une écriture
    serait visible, et le rapport doit donc annoncer ce qu'il s'apprête à faire.
    """
    _telecharger(sauvegarde_exportee, tmp_path / "copie")
    _detruire_objets(db_prete)
    lignes = db_prete.query(EpreuveFileORM).count()

    rapport = run_restore(
        db_prete, str(tmp_path / "copie"), mode=MODE_BUCKET, dossier_tmp=tmp_path / "tva"
    )
    assert rapport["dry_run"] is True
    assert rapport["ecrits"] == lignes  # ce qu'il ferait
    assert rapport["deja_presents"] == 0
    # ... et rien n'a bougé.
    for fichier in db_prete.query(EpreuveFileORM).all():
        assert not get_storage().exists(fichier.storage_key)


def test_recharge_bucket_ne_touche_pas_la_base(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """Le mode de recharge réécrit les objets et ne modifie AUCUNE ligne.

    Prémisse : la base est SAINE, seuls les objets ont disparu. C'est ce qui
    distingue ce mode du mode complet.
    """
    copie = _telecharger(sauvegarde_exportee, tmp_path / "copie")
    avant = [
        (f.id, f.storage_key, f.size_bytes)
        for f in db_prete.query(EpreuveFileORM).all()
    ]
    _detruire_objets(db_prete)
    assert not get_storage().exists(avant[0][1])

    rapport = run_restore(
        db_prete,
        str(copie),
        mode=MODE_BUCKET,
        dry_run=False,
        confirmation_recue=True,
        dossier_tmp=tmp_path / "tva",
    )
    assert rapport["ecrits"] == len(avant)
    assert rapport["erreurs"] == []
    apres = [
        (f.id, f.storage_key, f.size_bytes)
        for f in db_prete.query(EpreuveFileORM).all()
    ]
    assert apres == avant, "la base ne doit pas être modifiée"
    assert all(get_storage().exists(cle) for _, cle, _ in apres)


def test_recharge_bucket_idempotente(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """Relancer ne réécrit rien : c'est ce qui rend la reprise possible."""
    copie = _telecharger(sauvegarde_exportee, tmp_path / "copie")
    _detruire_objets(db_prete)
    premier = run_restore(
        db_prete,
        str(copie),
        mode=MODE_BUCKET,
        dry_run=False,
        confirmation_recue=True,
        dossier_tmp=tmp_path / "tva",
    )
    assert premier["ecrits"] > 0
    second = run_restore(
        db_prete,
        str(copie),
        mode=MODE_BUCKET,
        dry_run=False,
        confirmation_recue=True,
        dossier_tmp=tmp_path / "tva",
    )
    assert second["ecrits"] == 0
    assert second["deja_presents"] == second["fichiers"] > 0


def test_reprise_apres_coupure(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """Recharge partielle puis relance : le reliquat est complété."""
    copie = _telecharger(sauvegarde_exportee, tmp_path / "copie")
    _detruire_objets(db_prete)

    # Première passe, puis on simule une coupure : un objet disparaît après coup.
    run_restore(
        db_prete,
        str(copie),
        mode=MODE_BUCKET,
        dry_run=False,
        confirmation_recue=True,
        dossier_tmp=tmp_path / "tva",
    )
    victime = db_prete.query(EpreuveFileORM).first()
    get_storage().delete(victime.storage_key)

    rapport = run_restore(
        db_prete,
        str(copie),
        mode=MODE_BUCKET,
        dry_run=False,
        confirmation_recue=True,
        dossier_tmp=tmp_path / "tva",
    )
    assert rapport["ecrits"] == 1
    assert get_storage().exists(victime.storage_key)


def test_source_en_prefixe_de_stockage(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """La source peut être le préfixe de stockage, sans rien télécharger à la
    main : c'est le chemin normal d'une migration de bucket."""
    _detruire_objets(db_prete)
    rapport = run_restore(
        db_prete,
        sauvegarde_exportee,
        mode=MODE_BUCKET,
        dry_run=False,
        confirmation_recue=True,
        dossier_tmp=tmp_path / "tva",
    )
    assert rapport["ecrits"] > 0
    assert rapport["erreurs"] == [], rapport["erreurs"]


def test_fichiers_temporaires_supprimes(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """Le disque doit être rendu après une restauration."""
    _telecharger(sauvegarde_exportee, tmp_path / "copie")
    tva = tmp_path / "tva"
    tva.mkdir()
    run_restore(db_prete, str(tmp_path / "copie"), mode=MODE_BUCKET, dossier_tmp=tva)
    assert list(tva.glob("*")) == []


def test_progression_rapporte_des_compteurs(db_prete, sauvegarde_exportee, tmp_path) -> None:
    """Le compteur doit être croissant et boucler — sans quoi une barre de
    progression peut reculer ou dépasser 100 % pendant une restauration."""
    _detruire_objets(db_prete)
    vu: list[tuple] = []
    rapport = run_restore(
        db_prete,
        sauvegarde_exportee,
        mode=MODE_BUCKET,
        dry_run=False,
        confirmation_recue=True,
        dossier_tmp=tmp_path / "tva",
        progression=lambda *args: vu.append(args),
    )
    assert vu, "la progression doit être appelée"
    fichiers, total, octets, parties, parties_total = vu[0]
    # Premier point : rien de fait, mais le total est DÉJÀ connu (le manifeste
    # est lu avant la boucle) — c'est ce qui rend le pourcentage possible.
    assert (fichiers, octets) == (0, 0)
    assert total > 0
    assert parties_total >= 1

    fichiers = octets = -1
    for f, t, o, _p, _pt in vu:
        assert f >= fichiers, "le compteur de fichiers ne recule pas"
        assert o >= octets, "le compteur d'octets ne recule pas"
        assert f <= t
        assert t == total
        fichiers, octets = f, o

    assert fichiers == total, "la restauration doit finir à 100 %"
    # Le total d'octets annoncé est celui du manifeste, pas celui des octets
    # écrits : en mode `bucket` un objet déjà présent n'est pas réécrit.
    assert rapport["octets"] > 0
    assert parties >= 0
