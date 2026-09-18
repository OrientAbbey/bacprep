from __future__ import annotations

import re

import yaml
from sqlalchemy.orm import Session

from ..db import CORRIGES_SEED_DIR, SUJETS_SEED_DIR
from ..db_models import EpreuveFiliereORM, EpreuveORM
from . import epreuve_files, referentiel
from .logging_config import get_logger
from .storage import get_storage

log = get_logger("catalogue")

_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.DOTALL)


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Parse le frontmatter YAML d'un fichier de seed via PyYAML."""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    raw, body = m.group(1), m.group(2)
    meta = yaml.safe_load(raw) or {}
    return meta, body.strip() + "\n"


def _strip_frontmatter(text: str) -> str:
    """Retire le frontmatter d'un fichier de seed : seul le corps est stocké
    comme document (`sujet.md`/`corrige.md`) — les métadonnées de
    classification vivent en base, jamais dans le fichier servi."""
    _, body = _parse_frontmatter(text)
    return body


def seed_database_if_empty(db: Session) -> int:
    """Populate the catalogue from backend/data/epreuves/{sujets,corriges}
    if the epreuves table is currently empty. Returns the number created.

    Les fichiers .md sont écrits dans le stockage objet
    (``epreuves/{niveau}/{annee}/{epreuve_id}/sujet.md`` + ``corrige.md``) et
    référencés par des lignes `epreuve_files` — la base ne conserve aucune
    colonne de contenu."""
    existing = db.query(EpreuveORM).count()
    if existing > 0:
        return 0

    if not SUJETS_SEED_DIR.exists():
        log.warning("Seed directory missing: %s", SUJETS_SEED_DIR)
        return 0

    storage = get_storage()
    seen_filieres: set[str] = set()
    created = 0

    for path in sorted(SUJETS_SEED_DIR.glob("*.md")):
        raw = path.read_text(encoding="utf-8")
        meta, body = _parse_frontmatter(raw)

        filieres = meta.get("filieres")
        if not filieres:
            single = meta.get("filiere")
            filieres = [single] if single else []

        evaluation = referentiel.normalize_evaluation(meta.get("examen") or meta.get("evaluation"))
        niveau = referentiel.normalize_niveau(meta.get("niveau"))
        classe = referentiel.normalize_classe(meta.get("classe")) or (
            referentiel.default_classe_for_evaluation(evaluation) if niveau == referentiel.NIVEAU_SECONDAIRE else ""
        )

        epreuve = EpreuveORM(
            niveau=niveau,
            classe=classe or "terminale",
            evaluation=evaluation,
            matiere=meta.get("matiere", ""),
            annee=meta.get("annee", ""),
            duree=meta.get("duree"),
            coefficient=meta.get("coefficient"),
            statut="publie",
        )
        db.add(epreuve)
        db.flush()

        epreuve_files.write_document(db, epreuve, "sujet", body)

        corrige_path = CORRIGES_SEED_DIR / path.name
        if corrige_path.exists():
            epreuve_files.write_document(
                db, epreuve, "corrige", _strip_frontmatter(corrige_path.read_text(encoding="utf-8"))
            )

        is_free = False
        for f in filieres:
            f = referentiel.normalize_serie(f)
            if f not in seen_filieres:
                seen_filieres.add(f)
                is_free = True
            db.add(EpreuveFiliereORM(epreuve_id=epreuve.id, filiere=f))

        epreuve.gratuit = is_free
        db.commit()
        created += 1
        log.info(
            "Seed: épreuve '%s' créée (%s/%s/%s, matiere=%s, filières=%s, gratuit=%s)",
            epreuve.id, niveau, classe, evaluation, epreuve.matiere, filieres, is_free,
        )

    log.info("Seed terminé: %d épreuve(s) créée(s) — stockage=%s", created, storage.backend)
    return created
