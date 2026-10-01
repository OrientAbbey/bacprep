"""Restauration d'une sauvegarde (Phase 4 du plan `PLAN_SAUVEGARDES.md`).

Deux modes aux risques opposés, volontairement séparés :

- ``bucket`` — la base est intacte, seuls les objets ont disparu ou changé de
  fournisseur. On réécrit chaque objet à sa ``storage_key`` EXACTE. Aucune ligne
  de base n'est touchée, l'opération est idempotente, donc elle se relance
  après un incident. C'est le mode par défaut : c'est le cas d'usage principal
  (migration de bucket), et le seul sans risque de perte.
- ``disaster`` — la base elle-même est perdue. On rejoue le manifeste en
  préservant ``epreuves.id`` ET ``epreuve_files.id`` : c'est ce qui garde
  valides les références ``/api/files/{id}`` contenues dans le Markdown, et donc
  ce qui rend l'aller-retour fidèle sans réécrire un octet de document.
  Refusé si la table des épreuves n'est pas vide : il n'existe volontairement
  AUCUN contournement, importer par-dessus un catalogue existant reviendrait à
  fusionner deux jeu de données sans avoir quoi que ce dire des collisions.

``dry_run`` est le défaut dans les deux modes : rien n'est écrit tant que le
rapport n'a pas été lu.

Le manifeste coming d'une sauvegarde est une ENTRÉE NON FIABLE — il transite
par un fichier que l'on peut avoir fabriqué. Il est donc validé avant tout
accès (format, version, types, bornes, et surtout la sûreté des chemins), et
les octets sont vérifiés par SHA-256 AVANT d'être écrits.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import zipfile
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session

from ..db_models import EpreuveFileORM, EpreuveFiliereORM, EpreuveORM
from .export_service import FORMAT, NOM_INDEX, NOM_MANIFESTE, VERSION
from .logging_config import get_logger
from .storage import get_storage

log = get_logger("restore")

_BLOC = 1024 * 1024
# Garde-fous sur une entrée hostile. Volontairement larges : le besoin visé va
# jusqu'à plusieurs Go, un plafond bas rendrait l'outil inutilisable — un PDF
# d'épreuve ou un sujet complet dépasse couramment 200 Mo. Ils existent pour
# empêcher un manifeste forgé de remplir un disque, pas pour dire ce qu'est une
# sauvegarde légitime.
MAX_FICHIERS = int(os.getenv("SAUVEGARDE_MAX_FICHIERS", "500000"))
MAX_OCTETS = int(os.getenv("SAUVEGARDE_MAX_OCTETS", str(200 * 1024 * 1024 * 1024)))
MAX_FICHIER_OCTETS = int(os.getenv("SAUVEGARDE_MAX_FICHIER_OCTETS", str(2 * 1024 * 1024 * 1024)))

MODE_BUCKET = "bucket"
MODE_DISASTER = "disaster"
MODES = (MODE_BUCKET, MODE_DISASTER)


class ManifesteInvalide(ValueError):
    """Le manifeste n'est pas exploitable : rien n'est écrit."""


# --------------------------------------------------------------------------
# Validation d'une entrée non fiable
# --------------------------------------------------------------------------


def _chemin_sur(chemin: str) -> str:
    """Valide un chemin d'archive : relatif, sans remontée, sans ambiguïté.

    Le chemin sert à retrouver une entrée dans le ZIP ; il n'est jamais joint à
    un répertoire de travail (les octets sont streamés du ZIP vers le stockage,
    jamais extraits sur disque), mais une valeur malveillante doit être
    rejetée quand même : elle ne doit pas pouvoir désigner autre chose que
    l'entrée qu'elle prétends nommer.
    """
    if not isinstance(chemin, str) or not chemin or len(chemin) > 512:
        raise ManifesteInvalide(f"chemin d'archive invalide: {chemin!r}")
    if chemin.startswith("/") or "\\" in chemin or ":" in chemin:
        # Absolu, séparateur Windows, ou lettre de lecteur (`C:`).
        raise ManifesteInvalide(f"chemin d'archive invalide: {chemin!r}")
    segments = chemin.split("/")
    if any(s in ("", ".", "..") for s in segments):
        raise ManifesteInvalide(f"chemin d'archive invalide: {chemin!r}")
    return chemin


def _entier(valeur, nom: str, minimum: int = 0) -> int:
    if isinstance(valeur, bool) or not isinstance(valeur, int):
        raise ManifesteInvalide(f"{nom} doit être un entier, reçu {type(valeur).__name__}")
    if valeur < minimum:
        raise ManifesteInvalide(f"{nom} hors bornes: {valeur}")
    return valeur


def valider_manifeste(manifest: object) -> dict:
    """Valide la STRUCTURE d'un manifeste. Lève `ManifesteInvalide`.

    Ne vérifie pas que le contenu des fichiers est bon (c'est fait par
    checksum au moment de la lecture) : seulement que le manifeste est
    exploitable et sans surprise.
    """
    if not isinstance(manifest, dict):
        raise ManifesteInvalide("manifeste: objet JSON attendu")
    if manifest.get("format") != FORMAT:
        raise ManifesteInvalide(f"format inconnu: {manifest.get('format')!r}")
    version = manifest.get("version")
    if version != VERSION:
        raise ManifesteInvalide(
            f"version de sauvegarde non gérée: {version!r} (cette version gère {VERSION})"
        )
    epreuves = manifest.get("epreuves")
    if not isinstance(epreuves, list):
        raise ManifesteInvalide("epreuves: liste attendue")

    total = 0
    for epreuve in epreuves:
        if not isinstance(epreuve, dict):
            raise ManifesteInvalide("epreuve: objet attendu")
        eid = epreuve.get("id")
        if not isinstance(eid, str) or not eid or len(eid) > 128:
            raise ManifesteInvalide(f"epreuve.id invalide: {eid!r}")
        for champ in ("niveau", "classe", "evaluation", "matiere", "annee"):
            if not isinstance(epreuve.get(champ), str) or not epreuve.get(champ):
                raise ManifesteInvalide(f"epreuve.{champ} manquant ou invalide")
        filieres = epreuve.get("filieres", [])
        if not isinstance(filieres, list) or any(
            not isinstance(f, str) for f in filieres
        ):
            raise ManifesteInvalide(f"epreuve.filieres invalide pour {eid}")
        fichiers = epreuve.get("fichiers")
        if not isinstance(fichiers, list):
            raise ManifesteInvalide(f"epreuve.fichiers invalide pour {eid}")

        for fichier in fichiers:
            if not isinstance(fichier, dict):
                raise ManifesteInvalide("fichier: objet attendu")
            for champ in ("id", "cible", "format", "filename", "storage_key"):
                if not isinstance(fichier.get(champ), str) or not fichier.get(champ):
                    raise ManifesteInvalide(f"fichier.{champ} manquant ou invalide")
            # `storage_key` devient une clé de stockage : les mêmes garde-fous
            # que `normalize_key` s'appliquent, appliqués ici pour ne pas
            # dépendre du backend actif.
            cle = fichier["storage_key"]
            if cle.startswith("/") or "\\" in cle or ".." in cle.split("/"):
                raise ManifesteInvalide(f"storage_key invalide: {cle!r}")
            _chemin_sur(fichier.get("chemin", ""))
            _entier(fichier.get("sujet_index", 0), "fichier.sujet_index")
            _entier(fichier.get("size_bytes", 0), "fichier.size_bytes")
            if int(fichier.get("size_bytes", 0)) > MAX_FICHIER_OCTETS:
                raise ManifesteInvalide(
                    f"fichier trop volumineux ({fichier['size_bytes']} octets > {MAX_FICHIER_OCTETS})"
                )
            total += int(fichier.get("size_bytes", 0))

    if total > MAX_OCTETS:
        raise ManifesteInvalide(f"volume total au-delà du plafond: {total} > {MAX_OCTETS}")
    return manifest


# --------------------------------------------------------------------------
# Source : parties en stockage ou sur disque
# --------------------------------------------------------------------------


def _materialiser(cle: str, stockage, dossier_tmp: Path) -> Path:
    """Copie une partie du stockage dans un fichier temporaire.

    Lire un ZIP exige de pouvoir se déplacer (répertoire central en fin de
    fichier) : le flux du stockage n'est pas cherchable. La partie est donc
    amenée sur disque — une seule à la fois, jamais la sauvegarde entière.
    """
    destination = dossier_tmp / "partie_courante.zip"
    if destination.exists():
        destination.unlink()
    with destination.open("wb") as out:
        for bloc in stockage.open_read(cle):
            out.write(bloc)
    return destination


def _lire_manifeste(source: str, stockage) -> dict:
    """Lit et valide le manifeste, que la source soit un dossier ou un préfixe."""
    chemin = Path(source)
    if chemin.is_dir():
        fichier = chemin / NOM_MANIFESTE
        if not fichier.is_file():
            raise ManifesteInvalide(f"{NOM_MANIFESTE} introuvable dans {source}")
        with fichier.open("r", encoding="utf-8") as src:
            return valider_manifeste(json.load(src))
    cle = source.rstrip("/") + "/" + NOM_MANIFESTE
    if not stockage.exists(cle):
        raise ManifesteInvalide(f"{NOM_MANIFESTE} introuvable dans le préfixe {source}")
    return valider_manifeste(json.loads(stockage.get_bytes(cle).decode("utf-8")))


def _charger_index(source: str, stockage) -> dict[str, str]:
    """Retourne `{nom de partie: sha256 attendu}`.

    L'index n'est pas une commodité, c'est l'INVENTAIRE de la sauvegarde : il
    dit quelles parties existent et à quoi elles doivent ressembler. Sans lui on
    ne sait ni quoi lire, ni si ce qu'on lit est intact — on.restore donc
    refuse, dans les deux modes et depuis les deux types de source. Vérifier
    « si un hash est connu » laisserait passer une sauvegarde tronquée, ce qui
    est précisément le cas d'usage de cet outil.
    """
    chemin = Path(source)
    if chemin.is_dir():
        fichier = chemin / NOM_INDEX
        if not fichier.is_file():
            raise ManifesteInvalide(f"{NOM_INDEX} introuvable dans {source}")
        brut = fichier.read_bytes()
    else:
        cle = source.rstrip("/") + "/" + NOM_INDEX
        if not stockage.exists(cle):
            raise ManifesteInvalide(f"{NOM_INDEX} introuvable dans le préfixe {source}")
        brut = stockage.get_bytes(cle)
    try:
        index = json.loads(brut.decode("utf-8"))
    except ValueError as exc:
        raise ManifesteInvalide(f"{NOM_INDEX} illisible: {exc}") from exc
    parties = index.get("parties") if isinstance(index, dict) else None
    if not isinstance(parties, list) or not parties:
        raise ManifesteInvalide(f"{NOM_INDEX} : liste de parties vide ou invalide")
    attendu: dict[str, str] = {}
    for partie in parties:
        if not isinstance(partie, dict) or not isinstance(partie.get("nom"), str):
            raise ManifesteInvalide(f"{NOM_INDEX} : entrée de partie invalide")
        sha = partie.get("sha256")
        if not isinstance(sha, str) or len(sha) != 64:
            raise ManifesteInvalide(
                f"{NOM_INDEX} : SHA-256 absent ou invalide pour la partie {partie['nom']}"
            )
        if partie["nom"] in attendu:
            raise ManifesteInvalide(f"{NOM_INDEX} : partie en double {partie['nom']}")
        attendu[partie["nom"]] = sha
    return attendu


def _iter_parties(source: str, stockage, dossier_tmp: Path, noms: list[str]):
    """Produit `(nom, chemin)` pour chaque partie annoncée par l'index.

    On suit l'inventaire, pas le contenu du dossier : une partie présente sur
    disque mais absente de l'index n'appartient pas à cette sauvegarde et ne doit
    pas être lue, et une partie de l'index manquante doit être signalée.
    """
    chemin = Path(source)
    if chemin.is_dir():
        for nom in noms:
            fichier = chemin / nom
            if not fichier.is_file():
                raise ManifesteInvalide(f"partie annoncée mais absente: {nom}")
            yield nom, fichier
        return
    prefixe = source.rstrip("/") + "/"
    for nom in noms:
        cle = prefixe + nom
        if not stockage.exists(cle):
            raise ManifesteInvalide(f"partie annoncée mais absente du stockage: {nom}")
        yield nom, _materialiser(cle, stockage, dossier_tmp)


# --------------------------------------------------------------------------
# Vérification d'une partie
# --------------------------------------------------------------------------


def verifier_partie(chemin: Path, attendu: str) -> tuple[bool, str, int]:
    """Hache une partie sur disque. Retourne `(ok, sha256, octets)`.

    Détecte une sauvegarde tronquée ou altérée avant d'en extraire quoi que ce
    soit. `attendu` est obligatoire : sans référence, « intact » ne veut rien
    dire.
    """
    h = hashlib.sha256()
    octets = 0
    with chemin.open("rb") as src:
        while True:
            bloc = src.read(_BLOC)
            if not bloc:
                break
            h.update(bloc)
            octets += len(bloc)
    sha = h.hexdigest()
    return sha == attendu, sha, octets


# --------------------------------------------------------------------------
# Restauration
# --------------------------------------------------------------------------


def run_restore(
    db: Session,
    source: str,
    mode: str = MODE_BUCKET,
    dry_run: bool = True,
    on_progress=None,
    dossier_tmp: Optional[Path] = None,
    confirmation_recue: bool = False,
    progression=None,
) -> dict:
    """Restaure une sauvegarde. `dry_run` est le DÉFAUT : rien n'est écrit.

    `confirmation_recue` est le verrou d'écriture. Elle vaut `False` par défaut
    et doit être mise à `True` par l'appelant qui a lu le rapport et obtenu un
    accord explicite. Nommer la negatively aurait été une source d'erreur
    certaine : « ne pas attendre de confirmation » se lirait « aucune
    confirmation demandée », soit l'inverse de l'effet voulu.

    `progression(fichiers, total, octets, parties, parties_total)` est un
    compteur, distinct du journal `on_progress` : une restauration de plusieurs
    Go doit pouvoir afficher « 400 / 1 200 fichiers » et non faire deviner
    l'avancement à partir de lignes de log. Même signature que l'export.
    """
    if mode not in MODES:
        raise ManifesteInvalide(f"mode inconnu: {mode!r} (attendu: {', '.join(MODES)})")
    if not dry_run and not confirmation_recue:
        raise ManifesteInvalide(
            "restauration en écriture refusée : aucune confirmation explicite n'a été reçue"
        )

    stockage = get_storage()
    if dossier_tmp is None:
        dossier_tmp = Path(os.getenv("DATA_DIR", ".")) / "sauvegardes_tmp"
    dossier_tmp.mkdir(parents=True, exist_ok=True)

    report: dict = {
        "source": source,
        "mode": mode,
        "dry_run": dry_run,
        "epreuves": 0,
        "fichiers": 0,
        "deja_presents": 0,
        "ecrits": 0,
        "octets": 0,
        "parties": [],
        "corrompues": [],
        "introuvables": [],
        "incoherences": [],
        "erreurs": [],
    }

    manifest = _lire_manifeste(source, stockage)
    index = _charger_index(source, stockage)
    report["epreuves"] = len(manifest["epreuves"])

    if mode == MODE_DISASTER:
        existants = db.query(EpreuveORM).count()
        if existants:
            # Pas de contournement : importer par-dessus un catalogue peuplé
            # fusionnerait deux jeux de données, et la préservation d'id rend
            # précisément ces collisions destructrices.
            raise ManifesteInvalide(
                f"restauration complète refusée : la base contient déjà {existants} épreuve(s). "
                "Videz la base, ou utilisez le mode « recharge du stockage »."
            )

    # Index des entrées attendues, par chemin d'archive.
    attendus: dict[str, dict] = {}
    for epreuve in manifest["epreuves"]:
        for fichier in epreuve["fichiers"]:
            if fichier["chemin"] in attendus:
                raise ManifesteInvalide(f"chemin dupliqué dans le manifeste: {fichier['chemin']}")
            attendus[fichier["chemin"]] = dict(fichier, _epreuve=epreuve)
    if len(attendus) > MAX_FICHIERS:
        raise ManifesteInvalide(f"trop de fichiers: {len(attendus)} > {MAX_FICHIERS}")

    # Fichiers effectivement encounters dans les parties.
    traites: set[str] = set()
    # Total d'octets attendu, connu dès le manifeste : c'est lui qui donne un
    # pourcentage honnête (le nombre de fichiers ferait bondir la barre sur une
    # image unique de 400 Mio).
    octets_attendus = sum(int(f.get("size_bytes") or 0) for f in attendus.values())
    report["octets"] = octets_attendus
    # Cumul mis à jour en incrément : recalculer la somme sur `traites` à
    # chaque fichier serait quadratique sur un gros catalogue.
    octets_vus = 0
    if progression:
        # Signature commune à l'export : (fichiers, total, octets, parties,
        # parties_total). Aucune partie n'est terminée à cet instant, mais
        # leur nombre est déjà connu.
        progression(0, len(attendus), 0, 0, len(index))

    for nom, chemin in _iter_parties(source, stockage, dossier_tmp, list(index)):
        if on_progress:
            on_progress(f"Partie {nom}")
        ok, sha, octets = verifier_partie(chemin, index[nom])
        if not ok:
            report["corrompues"].append(
                {"partie": nom, "annonce": index[nom], "calcule": sha}
            )
            if on_progress:
                on_progress(f"  CORROMPUE — {nom}")
            continue
        report["parties"].append({"nom": nom, "sha256": sha, "octets": octets})
        try:
            with zipfile.ZipFile(chemin) as zf:
                # Pré-contrôle : une partie ambiguë ou hostile n'est pas
                # entamée du tout.
                problemes = _controler_partie(zf)
                if problemes:
                    report["erreurs"].extend(
                        {"partie": nom, "erreur": probleme} for probleme in problemes
                    )
                    if on_progress:
                        for probleme in problemes:
                            on_progress(f"  {probleme}")
                    continue
                for info in zf.infolist():
                    if info.is_dir():
                        continue
                    attendu = attendus.get(info.filename)
                    if attendu is None:
                        # Entrée non décrite par le manifeste : ignorée, et
                        # jamais écrite.
                        continue
                    _restaurer_un(
                        db, zf, info, attendu, stockage, report, dry_run, on_progress
                    )
                    traites.add(info.filename)
                    octets_vus += int(attendu.get("size_bytes") or 0)
                    if progression:
                        progression(
                            len(traites), len(attendus), octets_vus, len(index), octets_attendus
                        )
        except zipfile.BadZipFile as exc:
            report["erreurs"].append({"partie": nom, "erreur": f"archive illisible: {exc}"})
        finally:
            chemin = Path(chemin)
            if chemin.parent == dossier_tmp:
                chemin.unlink(missing_ok=True)

    for chemin_manquant in set(attendus) - traites:
        report["introuvables"].append(chemin_manquant)

    # Une restauration qui a laissé un fichier de côté n'est PAS une
    # restauration. Rejouer quand même les métadonnées créerait des lignes
    # pointant vers des objets absents — un catalogue qui affiche des documents
    # qu'on ne peut pas ouvrir, précisément ce qu'on cherchait à éviter.
    incomplete = _restauration_incomplete(report)
    if incomplete and not dry_run:
        report["erreurs"].append(
            {
                "erreur": "restauration incomplète : les métadonnées n'ont PAS été écrites "
                f"({len(report['introuvables'])} introuvable(s), "
                f"{len(report['incoherences'])} incohérent(s), "
                f"{len(report['corrompues'])} partie(s) corrompue(s))"
            }
        )

    if not dry_run:
        if mode == MODE_DISASTER and not incomplete:
            _ecrire_base(db, manifest, report)
            db.commit()
        else:
            # Rien n'a été écrit en base : on annule les écritures de session
            # sans toucher au reste. En `dry_run` on ne rollback pas, ce
            # jetterait le travail en cours de l'appelant.
            db.rollback()

    log.info(
        "Restauration %s (%s, dry_run=%s) : %s écrit(s), %s déjà présent(s), "
        "%s introuvable(s), %s partie(s) corrompue(s)",
        mode,
        source,
        dry_run,
        report["ecrits"],
        report["deja_presents"],
        len(report["introuvables"]),
        len(report["corrompues"]),
    )
    return report


def _restauration_incomplete(report: dict) -> bool:
    """Une restauration n'est complète que si RIEN n'a été laissé de côté.

    `erreurs` en fait partie : une partie abandonnée (structure ambiguë, archive
    illisible) laisse forcément des fichiers non traités, les compter doit
    empêcher la réécriture des métadonnées.
    """
    return bool(
        report["corrompues"]
        or report["incoherences"]
        or report["introuvables"]
        or report["erreurs"]
    )


def _controler_partie(zf: zipfile.ZipFile) -> list[str]:
    """Contrôle la STRUCTURE d'une partie avant d'en extraire quoi que ce soit.

    Deux entrées de même nom sont ambiguës — c'est le vecteur classique de
    « zip smuggling », où deux lecteurs n'interprètent pas la partie de la même
    façon — et un chemin hostile n'est jamais légitime. Dans les deux cas la
    partie est abandonnée ENTIÈRE, plutôt que d'en deviner le contenu ou d'écrire
    un objet avant de découvrir le problème.
    """
    problemes: list[str] = []
    vues: set[str] = set()
    for info in zf.infolist():
        if info.is_dir():
            continue
        try:
            _chemin_sur(info.filename)
        except ManifesteInvalide as exc:
            problemes.append(f"entrée refusée: {exc}")
            continue
        if info.filename in vues:
            problemes.append(f"entrée dupliquée: {info.filename}")
        vues.add(info.filename)
    return problemes


def _restaurer_un(
    db: Session,
    zf: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    attendu: dict,
    stockage,
    report: dict,
    dry_run: bool,
    on_progress,
) -> None:
    """Restaure un fichier unique : vérification du checksum AVANT écriture.

    Deux passes sur l'entrée du ZIP — la première ne fait que hacher, la
    seconde réouvre l'entrée pour la streamer. On ne constitue JAMAIS le
    fichier en mémoire : `morceaux` jusqu'au bout ferait revenir une
    sauvegarde de plusieurs Go dans la RAM du serveur.
    """
    total = 0
    h = hashlib.sha256()
    with zf.open(info) as src:
        for bloc in iter(lambda: src.read(_BLOC), b""):
            h.update(bloc)
            total += len(bloc)
            if total > MAX_FICHIER_OCTETS:
                raise ManifesteInvalide(
                    f"entrée {info.filename} dépasse le plafond par fichier"
                )

    calcule = h.hexdigest()
    annonce = attendu.get("checksum_sha256") or ""
    if annonce and calcule != annonce:
        # Corruption : rien n'est écrit. C'est le cœur de la valeur d'une
        # sauvegarde — un fichier silencieusement différent ne vaut rien.
        report["incoherences"].append(
            {"fichier": info.filename, "annonce": annonce, "calcule": calcule}
        )
        if on_progress:
            on_progress(f"  INCOHÉRENT — {info.filename}")
        return

    report["fichiers"] += 1
    cle = attendu["storage_key"]

    if stockage.exists(cle):
        report["deja_presents"] += 1
        return

    if not dry_run:
        def flux():
            with zf.open(info) as src:
                for bloc in iter(lambda: src.read(_BLOC), b""):
                    yield bloc

        stockage.put_stream(cle, flux(), mime_type=attendu.get("mime_type", ""))
    report["ecrits"] += 1
    if on_progress:
        on_progress(f"  {cle}")


def _ecrire_base(db: Session, manifest: dict, report: dict) -> None:
    """Rejoue les métadonnées en préservant les identifiants.

    Écrit APRÈS les objets : une coupure laisse alors des objets orphelins
    (inoffensifs) plutôt que des lignes pointant vers des fichiers absents
    (cassés).
    """
    for epreuve in manifest["epreuves"]:
        ligne = EpreuveORM(
            id=epreuve["id"],
            niveau=epreuve["niveau"],
            classe=epreuve["classe"],
            evaluation=epreuve["evaluation"],
            matiere=epreuve["matiere"],
            annee=epreuve["annee"],
            duree=epreuve.get("duree"),
            coefficient=epreuve.get("coefficient"),
            gratuit=bool(epreuve.get("gratuit", False)),
            statut=epreuve.get("statut", "brouillon"),
            extrait=epreuve.get("extrait", ""),
        )
        db.add(ligne)
        for filiere in epreuve.get("filieres", []):
            db.add(EpreuveFiliereORM(epreuve_id=epreuve["id"], filiere=filiere))
        for fichier in epreuve["fichiers"]:
            db.add(
                EpreuveFileORM(
                    id=fichier["id"],
                    epreuve_id=epreuve["id"],
                    cible=fichier["cible"],
                    format=fichier["format"],
                    sujet_index=int(fichier.get("sujet_index", 0)),
                    filename=fichier["filename"],
                    storage_key=fichier["storage_key"],
                    mime_type=fichier.get("mime_type", ""),
                    size_bytes=int(fichier.get("size_bytes", 0)),
                    width=fichier.get("width"),
                    height=fichier.get("height"),
                    checksum_sha256=fichier.get("checksum_sha256") or "",
                )
            )
        db.flush()
    log.info("Base reconstruite : %s épreuve(s)", len(manifest["epreuves"]))


def nettoyer_temporaire(dossier_tmp: Path) -> None:
    """Supprime le répertoire de travail d'une restauration."""
    shutil.rmtree(dossier_tmp, ignore_errors=True)
