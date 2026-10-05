"""Import massif d'épreuves Markdown + images depuis une arborescence locale
ou une archive zip (upload admin).

Le script parcourt récursivement, identifie les fichiers Markdown et images,
récupère les informations depuis l'arborescence (année, classe, matière,
série, sujet/corrigé — heuristiques dans `core/import_parsing.py`), crée les
entrées en base, copie les fichiers vers le stockage définitif
(``epreuves/{niveau}/{annee}/{epreuve_id}/...``), génère les storage_key,
détecte les doublons par checksum et signale les fichiers aux métadonnées
insuffisantes — conformément au prompt d'amélioration §2.

La classification métier vit en BASE, jamais dans l'arborescence physique
du stockage (l'arborescence ne reflète que niveau/année/épreuve).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session

from ..db_models import EpreuveFiliereORM, EpreuveFileORM, EpreuveORM
from . import epreuve_files, images, import_parsing, referentiel
from .logging_config import get_logger
from .storage import get_storage

log = get_logger("import")

MAX_FILE_BYTES = 10 * 1024 * 1024  # garde-fou par fichier importé
MAX_MARKDOWN_BYTES = 2 * 1024 * 1024  # un sujet/corrigé Markdown dépasse rarement quelques centaines de Ko
IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


def _rewrite_image_refs(content: str, rel_name: str, url: str) -> tuple[str, int, int]:
    """Remplace les références relatives pointant vers `rel_name` par `url`.

    Retourne `(contenu, nb_reecrits, nb_non_reecrits)`.

    Le motif utilisé auparavant — `\\]\\(<nom>\\)` — ne couvrait que la forme
    `![](image.png)`. Restaient intacts, donc affichés cassés et sans qu'aucune
    ligne de rapport ne le mentionne : `![alt](./image.png)`,
    `![alt](image.png "titre")` et `<img src="image.png">`. Un nom de fichier
    ne peut être confondu avec un autre : le éventuel segment de chemin doit
    être vide ou se terminer par un séparateur, donc `xa.png` ne matche pas
    `a.png`.

    Les formes NON réécrites (notamment les liens de référence
    `[alt][ref]` dont la définition est `[ref]: image.png`) sont COMPTEES, pas
    laissées passer en silence : l'appelant les remonte dans le rapport.
    """
    nom = re.escape(rel_name)
    # Vide, ou un segment relatif terminé par un séparateur.
    prefixe = r"(?:[^()\s\"'<>]*[/\\])?"

    md = re.compile(
        r"(\]\(\s*)" + prefixe + nom + r"(\s*(?:\"[^\"]*\"|'[^']*')?\s*\))",
        re.IGNORECASE,
    )
    html = re.compile(
        r"(<img\b[^>]*?\bsrc\s*=\s*)(\"|'?)" + prefixe + nom + r"(\2)",
        re.IGNORECASE,
    )
    # Les groupes sont reconstruits par fonction : l'URL contient des `/` et
    # des chiffres qui seraient mal interprétés dans une chaîne de
    # remplacement.
    contenu, n_md = md.subn(lambda m: m.group(1) + url + m.group(2), content)
    contenu, n_html = html.subn(
        lambda m: m.group(1) + m.group(2) + url + m.group(3), contenu
    )
    restant = re.compile(
        r"\]\(\s*" + prefixe + nom + r"(?![\w-])"
        r"|\bsrc\s*=\s*[\"']?" + prefixe + nom + r"(?![\w-])"
        r"|^[ \t]*\[[^\]]+\]:\s*" + prefixe + nom + r"(?![\w-])",
        re.IGNORECASE | re.MULTILINE,
    )
    return contenu, n_md + n_html, len(restant.findall(contenu))


def _contenus_partages(db: Session, checksum: str, exclude_epreuve: Optional[str] = None) -> list[str]:
    """Identifiants d'épreuve contenant DÉJÀ un fichier de mêmes octets.

    purement informatif — ce n'est PAS une détection de doublon. Deux épreuves
    peuvent légitimement partager des octets identiques (un logo commun à
    toutes les épreuves d'une année, une page de consignes réutilisée) : les
    refuser reviendrait à perdre des fichiers sans le moindre signal d'erreur.

    Le doublon réel est d'ordre LOGIQUE — même épreuve, même cible, même index
    de sujet — et il est détecté par `get_document` (documents) et par le nom de
    fichier déjà présent (images). Ces deux contrôles suffisent aussi à
    neutraliser la réimportation du même lot : la seconde passe retrouve la même
    épreuve et la même cible. Le contenu identique n'a donc rien à bloquer, et
    tout bloquer revient à générer des faux positifs.
    """
    query = db.query(EpreuveFileORM).filter(EpreuveFileORM.checksum_sha256 == checksum)
    if exclude_epreuve:
        query = query.filter(EpreuveFileORM.epreuve_id != exclude_epreuve)
    return sorted({row.epreuve_id for row in query.all()})


def _find_epreuve(db: Session, meta: dict) -> Optional[EpreuveORM]:
    """Retrouve une épreuve existante correspondant aux métadonnées (même
    niveau/classe/évaluation/matière/année), ou None."""
    evaluation = meta["evaluation"] or "AUTRE"
    annee = meta["annee"] or "0000"  # "0000" = à compléter, visible en back-office
    matiere = meta["matiere"] or "À qualifier"
    classe = meta["classe"] or referentiel.default_classe_for_evaluation(meta["evaluation"])
    return (
        db.query(EpreuveORM)
        .filter(
            EpreuveORM.niveau == meta["niveau"],
            EpreuveORM.classe == classe,
            EpreuveORM.evaluation == evaluation,
            EpreuveORM.matiere == matiere,
            EpreuveORM.annee == annee,
        )
        .one_or_none()
    )


def _create_epreuve(db: Session, meta: dict) -> EpreuveORM:
    """Crée l'épreuve d'un fichier importé en brouillon.

    IMPORTANT : l'évaluation stockée est TOUJOURS une valeur par défaut
    appliquée ("AUTRE" si absente), jamais None — sinon la recherche des
    fichiers suivants du même lot ne retrouve pas l'épreuve créée (le
    défaut SQL "BAC" n'est pas visible d'une requête `== None`) et en
    recrée une copie à chaque fichier."""
    e = EpreuveORM(
        niveau=meta["niveau"],
        classe=meta["classe"] or referentiel.default_classe_for_evaluation(meta["evaluation"]),
        evaluation=meta["evaluation"] or "AUTRE",
        matiere=meta["matiere"] or "À qualifier",
        annee=meta["annee"] or "0000",
        statut="brouillon",
    )
    db.add(e)
    db.flush()
    return e


def _import_markdown(
    db: Session, path: Path, root: Path, report: dict, dry_run: bool, batch_checksums: dict[str, str]
) -> Optional[EpreuveORM]:
    """Traite un fichier Markdown : renvoie l'épreuve créée/retrouvée, ou
    None si le fichier a été ignoré/doublonné/en erreur.

    L'ordre des vérifications garantit un rapport véridique : le doublon
    logique (un second sujet/corrigé pour la même épreuve) est détecté
    AVANT toute création d'épreuve et tout incrément de compteur — aucune
    mutation n'a alors lieu, donc plus de rollback qui annulait une
    épreuve déjà comptée comme créée."""
    meta = import_parsing.parse_path(path, root)
    if meta["manquants"]:
        report["metadonnees_manquantes"].append(
            {"fichier": str(path.relative_to(root)), "manquants": meta["manquants"]}
        )
    if not meta["classe"] or not meta["matiere"]:
        # Sans classe ni matière, l'épreuve serait introuvable dans la
        # navigation — signalée et ignorée plutôt que créée en vrac.
        report["ignores"].append(str(path.relative_to(root)))
        return None

    if path.stat().st_size > MAX_MARKDOWN_BYTES:
        report["erreurs"].append(
            {"fichier": str(path.relative_to(root)), "erreur": "markdown trop volumineux (>2 Mo)"}
        )
        return None
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        report["erreurs"].append({"fichier": str(path.relative_to(root)), "erreur": "encodage non UTF-8"})
        return None
    except OSError as exc:
        report["erreurs"].append({"fichier": str(path.relative_to(root)), "erreur": str(exc)})
        return None

    if not content.strip():
        report["ignores"].append(str(path.relative_to(root)))
        return None

    report["analyses"] += 1
    if dry_run:
        report["creees"].append({"fichier": str(path.relative_to(root)), "dry_run": True})
        return None

    data = content.encode("utf-8")
    checksum = epreuve_files.sha256_hex(data)
    # Contenu identique ailleurs : information, pas blocage (voir
    # `_contenus_partages`). Le doublon qui fait foi reste le doublon LOGIQUE,
    # détecté plus bas sur (epreuve, cible).
    partage = _contenus_partages(db, checksum)
    if batch_checksums.get(checksum):
        partage = list(partage) + [batch_checksums[checksum]]
    if partage:
        report["contenus_partages"].append(
            {"fichier": str(path.relative_to(root)), "deja_dans": sorted(set(partage))}
        )

    epreuve = _find_epreuve(db, meta)
    cible = meta["cible"]
    if epreuve is not None and epreuve_files.get_document(db, epreuve.id, cible):
        # Deux sujets (ou corrigés) pour la même épreuve du même lot :
        # le second est signalé comme doublon logique — sans créer ni
        # modifier quoi que ce soit.
        report["doublons"].append(
            {"fichier": str(path.relative_to(root)), "doublon_de": f"{epreuve.id}/{cible}"}
        )
        return None

    if epreuve is None:
        epreuve = _create_epreuve(db, meta)
        report["epreuves_creees"] += 1

    storage = get_storage()
    key = epreuve_files.document_key(epreuve, cible)
    storage.put_bytes(key, data, "text/markdown; charset=utf-8")
    db.add(
        EpreuveFileORM(
            epreuve_id=epreuve.id,
            cible=cible,
            format=epreuve_files.DOCUMENT_FORMAT,
            filename=f"{cible}.md",
            storage_key=key,
            mime_type="text/markdown; charset=utf-8",
            size_bytes=len(data),
            checksum_sha256=checksum,
        )
    )
    db.flush()

    if meta["serie"]:
        exists = (
            db.query(EpreuveFiliereORM)
            .filter(EpreuveFiliereORM.epreuve_id == epreuve.id, EpreuveFiliereORM.filiere == meta["serie"])
            .one_or_none()
        )
        if not exists:
            db.add(EpreuveFiliereORM(epreuve_id=epreuve.id, filiere=meta["serie"]))

    batch_checksums[checksum] = epreuve.id
    report["creees"].append(
        {
            "fichier": str(path.relative_to(root)),
            "epreuve_id": epreuve.id,
            "cible": cible,
            "storage_key": key,
        }
    )
    log.info("Import: %s → %s/%s (%s)", path.name, epreuve.id, cible, key)
    return epreuve


def _import_images_of_folder(
    db: Session, epreuve: EpreuveORM, folder: Path, root: Path, report: dict
) -> None:
    """Importe les images d'un dossier d'épreuve et réécrit les références
    relatives du document (``![](figure.png)``) vers ``/api/files/{id}``."""
    storage = get_storage()
    for image_path in sorted(folder.glob("*")):
        ext = image_path.suffix.lower()
        if ext not in IMAGE_MIME or not image_path.is_file():
            continue
        rel_name = image_path.name
        already = (
            db.query(EpreuveFileORM)
            .filter(EpreuveFileORM.epreuve_id == epreuve.id, EpreuveFileORM.filename == rel_name)
            .one_or_none()
        )
        if already:
            continue

        data = image_path.read_bytes()
        if len(data) > MAX_FILE_BYTES:
            report["erreurs"].append(
                {"fichier": str(image_path.relative_to(root)), "erreur": "image trop volumineuse (>10 Mo)"}
            )
            continue
        # Validation du contenu réel via Pillow (magic bytes) + réencodage :
        # une image importée ne stocke jamais ses octets bruts — un fichier
        # non décodable est signalé en erreur, pas persisté.
        try:
            data, image_mime, _, _ = images.process_image(data, IMAGE_MIME[ext])
        except images.InvalidImageError as exc:
            report["erreurs"].append(
                {"fichier": str(image_path.relative_to(root)), "erreur": f"image invalide : {exc}"}
            )
            continue
        checksum = epreuve_files.sha256_hex(data)
        partage = _contenus_partages(db, checksum, exclude_epreuve=epreuve.id)
        if partage:
            report["contenus_partages"].append(
                {"fichier": str(image_path.relative_to(root)), "deja_dans": partage}
            )

        row = epreuve_files.save_image(
            db, epreuve, "sujet", rel_name, data, image_mime
        )
        report["images_importees"] += 1

        # Réécrit les références relatives vers l'URL d'accès contrôlé dans
        # le SUJET et le CORRIGÉ (G5 : la même figure est souvent citée par
        # les deux documents), pas seulement le sujet.
        for cible_doc in ("sujet", "corrige"):
            doc = epreuve_files.get_document(db, epreuve.id, cible_doc)
            if not doc:
                continue
            try:
                content = storage.get_bytes(doc.storage_key).decode("utf-8")
            except Exception:
                continue
            new_content, _n_ecrits, n_non_ecrits = _rewrite_image_refs(
                content, rel_name, f"/api/files/{row.id}"
            )
            if n_non_ecrits:
                report["references_non_reecrites"].append(
                    {
                        "fichier": str(image_path.relative_to(root)),
                        "document": cible_doc,
                        "image": rel_name,
                        "nb": n_non_ecrits,
                    }
                )
            if new_content != content:
                storage.put_bytes(
                    doc.storage_key, new_content.encode("utf-8"), "text/markdown; charset=utf-8"
                )
                doc.size_bytes = len(new_content.encode("utf-8"))
                doc.checksum_sha256 = epreuve_files.sha256_hex(new_content.encode("utf-8"))
                db.add(doc)


def run_import(db: Session, root: Path, dry_run: bool = False, on_progress=None) -> dict:
    """Importe tout le contenu Markdown + images trouvés sous `root`.
    Retourne le rapport JSON-serializable (analyses, créées, doublons,
    erreurs, métadonnées manquantes...).

    `on_progress` (optionnel) est appelé avec une ligne de journal à chaque
    étape notable (analyse d'un fichier, création, doublon, erreur) —
    utilisé par l'import admin pour afficher les logs en direct."""
    report: dict = {
        "racine": str(root),
        "analyses": 0,
        "epreuves_creees": 0,
        "images_importees": 0,
        "creees": [],
        "doublons": [],
        "contenus_partages": [],
        "references_non_reecrites": [],
        "ignores": [],
        "erreurs": [],
        "metadonnees_manquantes": [],
    }

    def trace(message: str) -> None:
        log.info("Import: %s", message)
        if on_progress:
            try:
                on_progress(message)
            except Exception:  # pragma: no cover — le journal ne doit jamais casser l'import
                pass

    if not root.is_dir():
        report["erreurs"].append({"fichier": str(root), "erreur": "dossier introuvable"})
        return report

    batch_checksums: dict[str, str] = {}
    epreuve_by_dir: dict[Path, EpreuveORM] = {}

    md_files = sorted(p for p in root.rglob("*.md") if p.is_file())
    trace(f"{len(md_files)} fichier(s) Markdown trouvé(s)")
    for path in md_files:
        rel = str(path.relative_to(root))
        trace(f"Analyse de {rel}")
        try:
            epreuve = _import_markdown(db, path, root, report, dry_run, batch_checksums)
            if epreuve is not None:
                trace(f"Épreuve {epreuve.id} — {epreuve.matiere} ({epreuve.annee})")
            if not dry_run and epreuve is not None:
                epreuve_by_dir[path.parent] = epreuve
                db.commit()
        except Exception as exc:
            db.rollback()
            report["erreurs"].append({"fichier": rel, "erreur": str(exc)})
            trace(f"ERREUR sur {rel} : {exc}")
            log.exception("Échec d'import de %s", path)

    if not dry_run:
        # Chaque Markdown réussi est déjà committé fichier par fichier
        # (isolation d'un lot : un échec ultérieur ne perd pas les épreuves
        # précédentes) ; un échec est rolled back. La passe images ci-
        # dessous est committée en bloc à la fin.
        for folder, epreuve in epreuve_by_dir.items():
            try:
                _import_images_of_folder(db, epreuve, folder, root, report)
            except Exception as exc:
                db.rollback()
                report["erreurs"].append({"fichier": str(folder), "erreur": str(exc)})
                trace(f"ERREUR images de {folder} : {exc}")
                log.exception("Échec d'import des images de %s", folder)
        db.commit()

    trace(
        f"Import terminé — {report['epreuves_creees']} épreuve(s) créée(s), "
        f"{len(report['doublons'])} doublon(s), "
        f"{len(report['contenus_partages'])} contenu(s) partagé(s), "
        f"{len(report['erreurs'])} erreur(s)"
    )
    # Compteurs récapitulatifs calculés une seule fois (les listes restent la
    # source de vérité, les *count évitent aux consommateurs de faire len()).
    report["doublons_count"] = len(report["doublons"])
    report["contenus_partages_count"] = len(report["contenus_partages"])
    report["references_non_reecrites_count"] = len(report["references_non_reecrites"])
    report["ignores_count"] = len(report["ignores"])
    report["erreurs_count"] = len(report["erreurs"])
    report["metadonnees_manquantes_count"] = len(report["metadonnees_manquantes"])
    return report
