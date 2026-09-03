"""Import massif d'épreuves Markdown + images depuis une arborescence locale
ou une archive zip (upload admin).

Format attendu du dossier importé (tolérant) :

```
{annee}/{classe}/{matiere}/**   (un niveau racine optionnel est ignoré)
```

ex. ``imports/2023/Terminale/Mathématiques/bac-D-sujet.md``.

Le script parcourt récursivement, identifie les fichiers Markdown et images,
récupère les informations depuis l'arborescence (année, classe, matière,
série, sujet/corrigé), crée les entrées en base, copie les fichiers vers le
stockage définitif (``epreuves/{niveau}/{annee}/{epreuve_id}/...``), génère
les storage_key, détecte les doublons par checksum et signale les fichiers
aux métadonnées insuffisantes — conformément au prompt d'amélioration §2.

La classification métier vit en BASE, jamais dans l'arborescence physique
du stockage (l'arborescence ne reflète que niveau/année/épreuve).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session

from ..db_models import EpreuveFiliereORM, EpreuveFileORM, EpreuveORM
from . import epreuve_files, referentiel
from .logging_config import get_logger
from .storage import get_storage

log = get_logger("import")

MAX_FILE_BYTES = 10 * 1024 * 1024  # garde-fou par fichier importé
IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
}

_ANNEE_RE = re.compile(r"^(19|20)\d{2}$")
_CORRIGE_RE = re.compile(r"corrig[eé]|answer", re.IGNORECASE)
_SERIE_RE = re.compile(r"(?:serie|série|bac)\s*[:\- ]?\s*([A-Z])\b", re.IGNORECASE)


def _fold(value: str) -> str:
    return referentiel.fold(value)


def _guess_cible(path: Path) -> str:
    """Sujet ou corrigé selon le nom du fichier ("corrige..." → corrigé)."""
    return "corrige" if _CORRIGE_RE.search(path.stem) else "sujet"


def _guess_serie(text: str) -> Optional[str]:
    m = _SERIE_RE.search(text or "")
    return m.group(1).upper() if m else None


def _match_matiere(segment: str) -> Optional[str]:
    """Reconnaît une matière connue (comparaison insensible casse/accents)
    dans un segment de chemin — évite de prendre un nom de dossier
    quelconque pour une matière."""
    folded = _fold(segment)
    for matiere in referentiel.MATIERES_CONNUES:
        if folded == _fold(matiere):
            return matiere
    return None


def _parse_path(path: Path, root: Path) -> dict:
    """Extrait les métadonnées d'un fichier depuis son chemin relatif et son
    nom. Retourne un dict de champs trouvés + la liste des informations
    manquantes. Tolérant aux niveaux racine supplémentaires : chaque segment
    est identifié par sa nature (année, classe, niveau, matière) plutôt que
    par sa position."""
    rel = path.relative_to(root)
    parts = [p for p in rel.parts[:-1]]  # dossiers parents (hors nom de fichier)

    annee = None
    classe = None
    matiere = None
    niveau = referentiel.NIVEAU_SECONDAIRE

    # Passe 1 : segments non ambigus (année, niveau, classe, matière connue)
    restants: list[str] = []
    for part in parts:
        part = part.strip()
        if _ANNEE_RE.match(part):
            annee = annee or part
            continue
        if _fold(part) in ("primaire", "secondaire"):
            niveau = referentiel.normalize_niveau(part)
            continue
        normalized_classe = referentiel.normalize_classe(part)
        if normalized_classe and not classe:
            classe = normalized_classe
            continue
        restants.append(part)

    # Passe 2 : matière — priorité aux matières CONNUES, puis le segment
    # suivant la classe (convention {annee}/{classe}/{matiere}), puis le
    # dernier segment restant.
    for part in restants:
        known = _match_matiere(part)
        if known:
            matiere = known
            break
    if not matiere and classe:
        # segment immédiatement après la classe dans le chemin original
        try:
            idx = next(i for i, p in enumerate(parts) if referentiel.normalize_classe(p))
            if idx + 1 < len(parts):
                matiere = parts[idx + 1].strip() or None
        except StopIteration:
            pass
    if not matiere and restants:
        matiere = restants[-1].strip() or None

    filename_parts = path.stem
    serie = _guess_serie(filename_parts) or next(
        (s for s in (_guess_serie(p) for p in parts) if s), None
    )
    if not matiere:
        # "maths_2023" → "maths" : retire l'année en fin de nom de fichier
        matiere = re.sub(r"[_\- ]?(19|20)\d{2}$", "", filename_parts).strip() or None

    evaluation = _guess_evaluation(" ".join(parts)) or _guess_evaluation(filename_parts)

    manquants = []
    if not annee:
        manquants.append("annee")
    if not classe:
        manquants.append("classe")
    if not matiere:
        manquants.append("matiere")

    return {
        "niveau": niveau,
        "annee": annee,
        "classe": classe,
        "matiere": matiere,
        "serie": serie,
        "evaluation": evaluation,
        "cible": _guess_cible(path),
        "manquants": manquants,
    }


def _find_duplicate(db: Session, checksum: str, exclude_epreuve: Optional[str] = None) -> Optional[str]:
    """Identifiant d'épreuve contenant déjà ce checksum (doublon), si any."""
    query = db.query(EpreuveFileORM).filter(EpreuveFileORM.checksum_sha256 == checksum)
    if exclude_epreuve:
        query = query.filter(EpreuveFileORM.epreuve_id != exclude_epreuve)
    row = query.first()
    return row.epreuve_id if row else None


def _guess_evaluation(text: str) -> Optional[str]:
    """Détecte l'évaluation mentionnée dans un texte de chemin/nom de
    fichier : mots entiers pour les évaluations simples, motifs tolérants
    (espaces/dashes optionnels) pour les séquences et compositions."""
    folded = _fold(text or "")
    if not folded:
        return None
    simple = {
        r"\bbac\b": "BAC",
        r"\bb\.?ac\b": "BAC",
        r"\bbepc\b": "BEPC",
        r"\bprobatoire\b": "PROBATOIRE",
        r"\bcep\b": "CEP",
        r"\bconcours\b": "CONCOURS",
    }
    for pattern, code in simple.items():
        if re.search(pattern, folded):
            return code
    if re.search(r"sequence\s*0?1", folded):
        return "SEQUENCE 1"
    if re.search(r"sequence\s*0?2", folded):
        return "SEQUENCE 2"
    if re.search(r"sequence\s*0?3", folded):
        return "SEQUENCE 3"
    if re.search(r"composition\s*trimest", folded):
        return "COMPOSITION TRIMESTRIELLE"
    if re.search(r"examen\s*blanc", folded):
        return "EXAMEN BLANC"
    return None


def _find_or_create_epreuve(
    db: Session, meta: dict, batch_checksums: dict[str, str]
) -> tuple[EpreuveORM, bool]:
    """Retrouve une épreuve du lot correspondant aux métadonnées (même
    niveau/classe/évaluation/matière/année), ou la crée en brouillon. Le
    booléen vaut True si l'épreuve a été créée.

    IMPORTANT : l'évaluation stockée est TOUJOURS une valeur par défaut
    appliquée ("AUTRE" si absente), jamais None — sinon la recherche des
    fichiers suivants du même lot ne retrouve pas l'épreuve créée (le
    défaut SQL "BAC" n'est pas visible d'une requête `== None`) et en
    recrée une copie à chaque fichier."""
    evaluation = meta["evaluation"] or "AUTRE"
    annee = meta["annee"] or "0000"  # "0000" = à compléter, visible en back-office
    matiere = meta["matiere"] or "À qualifier"
    classe = meta["classe"] or referentiel.default_classe_for_evaluation(meta["evaluation"])

    existing = (
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
    if existing:
        return existing, False

    e = EpreuveORM(
        niveau=meta["niveau"],
        classe=classe,
        evaluation=evaluation,
        matiere=matiere,
        annee=annee,
        statut="brouillon",
    )
    db.add(e)
    db.flush()
    return e, True


def _import_markdown(
    db: Session, path: Path, root: Path, report: dict, dry_run: bool, batch_checksums: dict[str, str]
) -> Optional[EpreuveORM]:
    """Traite un fichier Markdown : renvoie l'épreuve créée/retrouvée, ou
    None si le fichier a été ignoré/doublonné/ en erreur."""
    meta = _parse_path(path, root)
    if meta["manquants"]:
        report["metadonnees_manquantes"].append(
            {"fichier": str(path.relative_to(root)), "manquants": meta["manquants"]}
        )
    if not meta["classe"] or not meta["matiere"]:
        # Sans classe ni matière, l'épreuve serait introuvable dans la
        # navigation — signalée et ignorée plutôt que créée en vrac.
        report["ignores"].append(str(path.relative_to(root)))
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
    doublon = _find_duplicate(db, checksum) or batch_checksums.get(checksum)
    if doublon:
        report["doublons"].append(
            {"fichier": str(path.relative_to(root)), "doublon_de": doublon}
        )
        return None

    epreuve, created = _find_or_create_epreuve(db, meta, batch_checksums)
    if created:
        report["epreuves_creees"] += 1

    cible = meta["cible"]
    existing_doc = epreuve_files.get_document(db, epreuve.id, cible)
    if existing_doc:
        # Deux sujets (ou corrigés) pour la même épreuve du même lot :
        # le second est signalé comme doublon logique.
        report["doublons"].append(
            {"fichier": str(path.relative_to(root)), "doublon_de": f"{epreuve.id}/{cible}"}
        )
        db.rollback()
        return None

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
    db: Session, folder: Path, root: Path, epreuve_by_dir: dict[Path, EpreuveORM], report: dict
) -> None:
    """Importe les images d'un dossier d'épreuve et réécrit les références
    relatives du document (``![](figure.png)``) vers ``/api/files/{id}``."""
    storage = get_storage()
    for image_path in sorted(folder.glob("*")):
        ext = image_path.suffix.lower()
        if ext not in IMAGE_MIME or not image_path.is_file():
            continue
        epreuve = epreuve_by_dir.get(folder)
        if not epreuve:
            return
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
        checksum = epreuve_files.sha256_hex(data)
        if _find_duplicate(db, checksum, exclude_epreuve=epreuve.id):
            report["doublons"].append(
                {"fichier": str(image_path.relative_to(root)), "doublon_de": "autre épreuve"}
            )
            continue

        row = epreuve_files.save_image(
            db, epreuve, "sujet", rel_name, data, IMAGE_MIME[ext]
        )
        report["images_importees"] += 1

        # Réécrit les références relatives du sujet vers l'URL d'accès contrôlé
        doc = epreuve_files.get_document(db, epreuve.id, "sujet")
        if doc:
            try:
                content = storage.get_bytes(doc.storage_key).decode("utf-8")
            except Exception:
                continue
            new_content = re.sub(
                r"(\]\()(" + re.escape(rel_name) + r")(\))",
                rf"\g<1>/api/files/{row.id}\g<3>",
                content,
            )
            if new_content != content:
                storage.put_bytes(
                    doc.storage_key, new_content.encode("utf-8"), "text/markdown; charset=utf-8"
                )
                doc.size_bytes = len(new_content.encode("utf-8"))
                doc.checksum_sha256 = epreuve_files.sha256_hex(new_content.encode("utf-8"))
                db.add(doc)


def run_import(db: Session, root: Path, dry_run: bool = False) -> dict:
    """Importe tout le contenu Markdown + images trouvés sous `root`.
    Retourne le rapport JSON-serializable (analyses, créées, doublons,
    erreurs, métadonnées manquantes...)."""
    report: dict = {
        "racine": str(root),
        "analyses": 0,
        "epreuves_creees": 0,
        "images_importees": 0,
        "creees": [],
        "doublons": [],
        "ignores": [],
        "erreurs": [],
        "metadonnees_manquantes": [],
    }
    if not root.is_dir():
        report["erreurs"].append({"fichier": str(root), "erreur": "dossier introuvable"})
        return report

    batch_checksums: dict[str, str] = {}
    epreuve_by_dir: dict[Path, EpreuveORM] = {}

    md_files = sorted(p for p in root.rglob("*.md") if p.is_file())
    for path in md_files:
        try:
            epreuve = _import_markdown(db, path, root, report, dry_run, batch_checksums)
            if not dry_run and epreuve is not None:
                epreuve_by_dir[path.parent] = epreuve
                db.commit()
        except Exception as exc:
            db.rollback()
            report["erreurs"].append({"fichier": str(path.relative_to(root)), "erreur": str(exc)})
            log.exception("Échec d'import de %s", path)

    if not dry_run:
        db.commit()
        for folder, epreuve in epreuve_by_dir.items():
            try:
                _import_images_of_folder(db, folder, root, epreuve_by_dir, report)
            except Exception as exc:
                db.rollback()
                report["erreurs"].append({"fichier": str(folder), "erreur": str(exc)})
                log.exception("Échec d'import des images de %s", folder)
        db.commit()

    return report
