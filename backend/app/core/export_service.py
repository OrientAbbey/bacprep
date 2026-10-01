"""Export de sauvegarde du catalogue d'épreuves (Phase 2 du plan
`PLAN_SAUVEGARDES.md`).

Produit un ensemble d'objets dans le stockage, sous
``_sauvegardes/<horodatage>/`` :

- ``manifest.json``  : l'état AUTORITATIF — toutes les colonnes des épreuves et
  des fichiers, y compris celles que l'import heuristique ignore (``statut``,
  ``duree``, ``coefficient``, ``gratuit``, ``sujet_index > 0``) et **l'id de
  ligne de chaque fichier** ;
- ``index.json``     : SHA-256 et taille de chaque partie ;
- ``sauvegarde.zip``  : un seul ZIP si le total tient sous le seuil ;
  sinon ``part-0001.zip``, ``part-0002.zip``… chacun **autonome**.

Pourquoi conserver les id : le contenu Markdown référence les images par
``/api/files/{id}``, où ``id`` est l'identifiant de la ligne ``epreuve_files``.
Les préserver rend ces références valides telles quelles après restauration —
c'est ce qui permet un aller-retour fidèle sans réécrire un seul octet de
Markdown.

Écriture en flux : la taille peut dépasser la mémoire disponible. Chaque objet
est lu bloc par bloc, transferé dans le ZIP et haché au passage ; la partie
courante est matérialisée dans un fichier temporaire unique (borne à
``TAILLE_PARTIE``), téléversée puis supprimée. Le pic disque est donc une
partie, jamais la sauvegarde entière.

Un objet MANQUANT en stockage n'interrompt pas l'export : il est déclaré
``absent`` dans le manifeste et listé dans le rapport. Diagnostiquer une perte
de stockage fait partie du travail d'une sauvegarde.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
import zipfile
from pathlib import Path
from typing import Iterator, Optional

from sqlalchemy.orm import Session

from ..db_models import EpreuveFileORM, EpreuveORM
from .epreuve_files import DOCUMENT_FORMAT
from .logging_config import get_logger
from .storage import StorageError, get_storage

log = get_logger("export")

FORMAT = "bacprep-export"
VERSION = 1
PREFIXE = "_sauvegardes"
NOM_MANIFESTE = "manifest.json"
NOM_INDEX = "index.json"
NOM_SAUVEGARDE = "sauvegarde.zip"
# Procédure de restauration embarquée dans la sauvegarde. Une sauvegarde dont on
# ne sait pas la relire n'est qu'un fichier .zip : la procédure doit voyager
# AVEC les données, pas rester dans la documentation du dépôt.
NOM_LISEZMOI = "LISEZMOI.txt"
TMOIS = 1024 * 1024 * 1024  # 1 Gio
PARTIE = 256 * 1024 * 1024  # 256 Mio
_BLOC = 1024 * 1024


def seuil_partie_octets() -> int:
    return int(os.getenv("SAUVEGARDE_SEUILLE_PARTIE_OCTETS", str(TMOIS)))


def taille_partie_octets() -> int:
    return int(os.getenv("SAUVEGARDE_TAILLE_PARTIE_OCTETS", str(PARTIE)))


# --------------------------------------------------------------------------
# Manifeste
# --------------------------------------------------------------------------


def _nom_dans_archive(fichier: EpreuveFileORM) -> str:
    """Nom de l'entrée dans le ZIP, calqué sur le nom d'objet en stockage.

    Reproduit `document_key` / `image_key` : `sujet.md`, `sujet_1.md`,
    `sujet-figure.png`. La clé de stockage étant UNIQUE en base, ces noms sont
    uniques pour une épreuve donnée.
    """
    if fichier.format == DOCUMENT_FORMAT:
        base = fichier.cible if not fichier.sujet_index else f"{fichier.cible}_{fichier.sujet_index}"
        return f"{base}.md"
    return f"{fichier.cible}-{fichier.filename}"


def build_manifest(db: Session, exporte_le: str) -> dict:
    """Sérialise TOUT l'état du catalogue en mémoire.

    Un manifeste de plusieurs centaines d'épreuves pèse quelques Mo : il reste
    très en deçà du format ZIP et peut donc être produit avant l'écriture des
    parties, pour qu'il existe même si une partie échoue ensuite.
    """
    epreuves = db.query(EpreuveORM).order_by(EpreuveORM.id).all()
    entrees: list[dict] = []
    nb_fichiers = 0
    octets = 0

    for epreuve in epreuves:
        # `lazy="selectin"` : une requête groupée pour les fichiers, une pour
        # les filières — pas de N+1 sur un catalogue entier.
        fichiers = sorted(
            epreuve.files_rel,
            key=lambda f: (f.format, f.cible, f.sujet_index, f.id),
        )
        liste = []
        for f in fichiers:
            nb_fichiers += 1
            octets += int(f.size_bytes or 0)
            liste.append(
                {
                    "id": f.id,
                    "cible": f.cible,
                    "format": f.format,
                    "sujet_index": int(f.sujet_index or 0),
                    "filename": f.filename,
                    "chemin": f"fichiers/{epreuve.id}/{_nom_dans_archive(f)}",
                    "storage_key": f.storage_key,
                    "mime_type": f.mime_type or "",
                    "size_bytes": int(f.size_bytes or 0),
                    "width": f.width,
                    "height": f.height,
                    "checksum_sha256": f.checksum_sha256 or "",
                }
            )
        entrees.append(
            {
                "id": epreuve.id,
                "niveau": epreuve.niveau,
                "classe": epreuve.classe,
                "evaluation": epreuve.evaluation,
                "matiere": epreuve.matiere,
                "annee": epreuve.annee,
                "duree": epreuve.duree,
                "coefficient": epreuve.coefficient,
                "gratuit": bool(epreuve.gratuit),
                "statut": epreuve.statut,
                "extrait": epreuve.extrait,
                # Triée : la même base doit produire un manifeste identique.
                "filieres": sorted(epreuve.filieres),
                "fichiers": liste,
            }
        )

    return {
        "format": FORMAT,
        "version": VERSION,
        "exporte_le": exporte_le,
        "epreuve_count": len(entrees),
        "fichier_count": nb_fichiers,
        "octets": octets,
        "epreuves": entrees,
    }


def iter_fichiers(manifest: dict) -> Iterator[dict]:
    """Parcourt les entrées de fichier dans un ordre DÉTERMINISTE.

    L'ordre de la construction du manifeste est déjà trié par épreuve ; on le
    conserve explicitement pour qu'un même état donne toujours la même découpe
    en parties, donc un ré-export comparable octet pour octet.
    """
    for epreuve in manifest["epreuves"]:
        for fichier in epreuve["fichiers"]:
            yield fichier


# --------------------------------------------------------------------------
# Écriture en flux
# --------------------------------------------------------------------------


class _FichierHache:
    """OBSOLÈTE — supprimé.

    Première version : proxy d'un fichier temporaire qui calculait le SHA-256
    au fil des écritures. Elle est fausse, et le test l'a démontré : `zipfile`
    REPOSTE PAR-DESSUS les en-têtes locaux pour y inscrire CRC et tailles, donc
    la séquence d'écritures ne correspond pas aux octets finaux (mesuré : 430
    octets écrits contre 314 dans le fichier). Le hash sert à l'`index.json` pour
    détecter une sauvegarde corrompue : il doit décrire le fichier RÉEL.

    Le remplacement est `_televerser_et_hacher`, qui relit la partie une fois en
    calculant le hash du contenu réellement stocké.
    """


def _televerser_et_hacher(stockage, cle: str, chemin: Path, mime_type: str) -> tuple[str, int]:
    """Téléverse un fichier en UNE SEULE lecture, SHA-256 compris.

    Le `size` n'est pas annoncé à `put_stream` : la taille n'est connue qu'après
    épuisement du flux, et l'argument serait évalué avant. Ce n'est pas une perte
    de garantie d'intégrité — c'est précisément le SHA-256 returned, consigné dans
    `index.json`, que la restauration revérifiera en relisant l'objet stocké : un
    téléversement tronqué serait détecté à ce moment-là.

    Retourne `(sha256, octets)`.
    """
    h = hashlib.sha256()
    compte = {"octets": 0}

    def flux():
        with chemin.open("rb") as src:
            while True:
                bloc = src.read(_BLOC)
                if not bloc:
                    break
                h.update(bloc)
                compte["octets"] += len(bloc)
                yield bloc

    stockage.put_stream(cle, flux(), mime_type=mime_type)
    return h.hexdigest(), compte["octets"]


def _ecrire_partie(
    destination,
    nom: str,
    fichiers: list[dict],
    stockage,
    dossier_tmp: Path,
    report: dict,
    on_progress=None,
    on_fichier=None,
) -> dict:
    """Écrit une partie ZIP autonome et la téléverse. Retourne sa fiche index.

    `on_fichier(traites, octets)` est appelé après chaque ENTRÉE traitée, y
    compris une entrée absente du stockage ou de lecture interrompue. C'est ce
    qui permet à la barre d'avancement de bouger pendant la compression, qui
    est le long du travail : sans ce rappel, la progression n'était rapportée
    qu'une fois par partie, donc une sauvegarde en une seule partie — le cas
    courant sous 1 Go — affichait 0 % pendant toute l'export, puis 100 % d'un
    coup. Un compteur qui ne bouge pas pendant l'opération est pire
    qu'absence de compteur : il affirme que le travail n'avance pas.
    """
    chemin_tmp = dossier_tmp / (nom + ".tmp")
    ecrits = 0
    traites = 0
    octets_vus = 0
    with chemin_tmp.open("wb") as fh:
        with zipfile.ZipFile(fh, "w", zipfile.ZIP_DEFLATED) as zf:
            for fichier in fichiers:
                if on_progress:
                    on_progress(f"[{nom}] {fichier['chemin']}")
                # L'entrée est comptée AVANT toute écriture : une entrée qui
                # échoue doit quand même faire avancer la barre, sinon elle
                # resterait bloquée juste avant 100 % sur une sauvegarde
                # contenant un objet manquant.
                traites += 1
                octets_vus += int(fichier.get("size_bytes") or 0)
                if on_fichier:
                    on_fichier(traites, octets_vus)
                # L'existence est vérifiée AVANT d'ouvrir l'entrée : une
                # entrée tronquée dans le ZIP donnerait un fichier partiel
                # que la restauration extrairait tel quel.
                if not stockage.exists(fichier["storage_key"]):
                    report["absents"].append(
                        {
                            "fichier": fichier["chemin"],
                            "storage_key": fichier["storage_key"],
                            "erreur": "objet absent du stockage",
                        }
                    )
                    continue
                try:
                    # Lecture par blocs : un fichier de 100 Mo ne transite pas
                    # en mémoire, et le hash est calculé pendant le transfert.
                    h = hashlib.sha256()
                    with zf.open(fichier["chemin"], "w") as entree:
                        for bloc in stockage.open_read(fichier["storage_key"]):
                            entree.write(bloc)
                            h.update(bloc)
                except (StorageError, OSError) as exc:
                    report["erreurs"].append(
                        {
                            "fichier": fichier["chemin"],
                            "storage_key": fichier["storage_key"],
                            "erreur": f"lecture interrompue : {exc}",
                        }
                    )
                    continue
                attendu = fichier.get("checksum_sha256") or ""
                if attendu and h.hexdigest() != attendu:
                    # L'objet en stockage ne correspond plus à ce que la base
                    # annonce : signalement explicite, l'entrée est tout de
                    # même écrite (le contenu réel prime).
                    report["incoherences"].append(
                        {
                            "fichier": fichier["chemin"],
                            "annonce": attendu,
                            "calcule": h.hexdigest(),
                        }
                    )
                ecrits += 1

    # Le ZipFile est fermé : le répertoire central est écrit. On téléverse
    # ensuite la partie, puis on libère le disque.
    try:
        sha, octets = _televerser_et_hacher(
            stockage, destination + nom, chemin_tmp, "application/zip"
        )
    finally:
        chemin_tmp.unlink(missing_ok=True)
    return {
        "nom": nom,
        "sha256": sha,
        "octets": octets,
        # Ce qui est RÉELLEMENT écrit, pas la taille du lot : un objet absent
        # ou une lecture interrompue ne produit aucune entrée, et une fiche de
        # index qui annoncerait le nombre du lot serait un mensonge.
        "nb_fichiers": ecrits,
    }


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------


def run_export(
    db: Session,
    destination: str,
    on_progress=None,
    dossier_tmp: Optional[Path] = None,
    progression=None,
    periode_progression: float = 0.4,
) -> dict:
    """Exporte tout le catalogue. `destination` est le préfixe de stockage,
    sans slash final (ex. `_sauvegardes/2026-09-27T2240Z`).

    Retourne le rapport : compteurs, parties produites, incohérences et
    erreurs. N'interrompt jamais sur un objet manquant — il le signale.

    `progression(fichiers_faits, fichiers_total, parties_faites, parties_total,
    octets_faits)` est appelé après chaque **entrée traitée**, et toujours en
    fin de partie. Il est séparé de `on_progress` parce que l'IHM a besoin de
    COMPTEURS : les messages sont destinés à l'affichage, et les relire pour en
    déduire un pourcentage les rendrait fragiles au premier mot modifié.

    `periode_progression` borne la cadence (secondes entre deux écritures en
    base). Elle est un paramètre et non une constante pour que le test puisse
    la mettre à zéro et observer une progression à chaque fichier, au lieu
    d'attendre quatre dixièmes de seconde et d'espérer que l'export dure
    assez longtemps — un test dont le résultat dépend de la vitesse de la
    machine n'est pas un test.
    """
    from ..db import utc_now

    stockage = get_storage()
    if dossier_tmp is None:
        dossier_tmp = Path(os.getenv("DATA_DIR", ".")) / "sauvegardes_tmp"
    dossier_tmp.mkdir(parents=True, exist_ok=True)

    prefixe = destination.rstrip("/") + "/"
    report: dict = {
        "destination": destination,
        "manifeste": None,
        "index": None,
        "parties": [],
        "nb_fichiers": 0,
        "octets": 0,
        "absents": [],
        "incoherences": [],
        "erreurs": [],
    }

    manifest = build_manifest(db, utc_now().isoformat())
    stockage.put_stream(
        prefixe + NOM_MANIFESTE,
        [json.dumps(manifest, ensure_ascii=False, indent=1).encode("utf-8")],
        mime_type="application/json",
    )
    # La procédure part AVEC la sauvegarde. Un échec d'écriture ici ne doit pas
    # faire perdre l'export : elle est signalée, le catalogue est exporté.
    try:
        stockage.put_stream(
            prefixe + NOM_LISEZMOI,
            [Path(__file__).with_name("sauvegarde_lisezmoi.txt").read_bytes()],
            mime_type="text/plain; charset=utf-8",
        )
    except (OSError, StorageError) as exc:
        report["erreurs"].append(
            {"fichier": NOM_LISEZMOI, "erreur": f"procédure non embarquée: {exc}"}
        )
        log.warning("Procédure de restauration non embarquée dans %s : %s", destination, exc)

    report["manifeste"] = manifest
    report["nb_fichiers"] = manifest["fichier_count"]
    report["octets"] = manifest["octets"]
    if on_progress:
        on_progress(
            f"Manifeste écrit — {manifest['epreuve_count']} épreuve(s), "
            f"{manifest['fichier_count']} fichier(s), {manifest['octets']} octets"
        )

    # Un seul ZIP tant que le total tient sous le seuil ; au-delà, des parties
    # autonomes de taille fixe.
    if manifest["octets"] <= seuil_partie_octets():
        lots = [[f for f in iter_fichiers(manifest)]]
        nom_commun = NOM_SAUVEGARDE
    else:
        limite = taille_partie_octets()
        lots, courant, courant_octets = [], [], 0
        for f in iter_fichiers(manifest):
            taille = int(f.get("size_bytes") or 0)
            # Un fichier seul dépasse la limite : il part dans sa propre
            # partie plutôt que de faire déborder la suivante.
            if courant and courant_octets + taille > limite:
                lots.append(courant)
                courant, courant_octets = [], 0
            courant.append(f)
            courant_octets += taille
        if courant:
            lots.append(courant)
        nom_commun = "part-{numero:04d}.zip"

    if progression:
        progression(0, manifest["fichier_count"], 0, len(lots), 0)

    # Compteurs cumulés, et un garde-fou de cadence.
    #
    # `progresser` écrit en base (un COMMIT par appel) : l'appeler pour chaque
    # fichier d'un catalogue de plusieurs milliers générerait des milliers de
    # transactions pour un écran qui n'est rafraîchi que toutes les 1,5 s.
    # On limite donc à ~2 écritures par seconde — assez pour que la barre
    # bouge visiblement, assez peu pour que la base ne paie pas le comptage.
    # `dernier` vaut 0.0, ce qui force le premier appel.
    dernier = [0.0]
    cumules = {"fichiers": 0, "octets": 0}

    def _annoncer(partie: int, force: bool = False) -> None:
        if not progression:
            return
        maintenant = time.monotonic()
        if not force and maintenant - dernier[0] < periode_progression:
            return
        dernier[0] = maintenant
        progression(
            cumules["fichiers"],
            manifest["fichier_count"],
            partie,
            len(lots),
            cumules["octets"],
        )

    for i, lot in enumerate(lots, start=1):
        nom = nom_commun if nom_commun == NOM_SAUVEGARDE else nom_commun.format(numero=i)
        if on_progress:
            on_progress(f"Partie {i}/{len(lots)} — {len(lot)} fichier(s)")
        deja_vus = cumules["fichiers"]
        octets_deja = cumules["octets"]

        def _sur_fichier(traites: int, octets: int, _i=i, _d=deja_vus, _o=octets_deja) -> None:
            cumules["fichiers"] = _d + traites
            cumules["octets"] = _o + octets
            _annoncer(_i)

        fiche = _ecrire_partie(
            prefixe,
            nom,
            lot,
            stockage,
            dossier_tmp,
            report,
            on_progress,
            on_fichier=_sur_fichier,
        )
        # Le cumul est aligné sur ce que la fiche dit RÉELLEMENT écrit, pas sur
        # le nombre d'entrées traversées : un objet absent ne doit pas faire
        # mentir le total du job, et l'écart doit être visible.
        cumules["fichiers"] = deja_vus + fiche["nb_fichiers"]
        cumules["octets"] = octets_deja + fiche["octets"]
        report["parties"].append(fiche)
        if progression:
            progression(
                cumules["fichiers"],
                manifest["fichier_count"],
                i,
                len(lots),
                cumules["octets"],
            )

    index = {
        "manifeste": NOM_MANIFESTE,
        "manifeste_sha256": hashlib.sha256(
            json.dumps(manifest, ensure_ascii=False, indent=1).encode("utf-8")
        ).hexdigest(),
        "parties": report["parties"],
        "total_octets": sum(p["octets"] for p in report["parties"]),
    }
    stockage.put_stream(
        prefixe + NOM_INDEX,
        [json.dumps(index, ensure_ascii=False, indent=1).encode("utf-8")],
        mime_type="application/json",
    )
    report["index"] = index
    log.info(
        "Export terminé : %s partie(s), %s fichier(s), %s octets",
        len(report["parties"]),
        report["nb_fichiers"],
        report["octets"],
    )
    return report
