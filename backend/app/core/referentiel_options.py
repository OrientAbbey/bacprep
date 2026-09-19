"""Persistance des listes du référentiel (table ``referentiel_options``).

Seed au démarrage depuis ``core/referentiel.py`` (voir ``main.py``) et
helpers de lecture/auto-ajout utilisés par le routeur admin (onglet
« Paramètres ») et par les formulaires d'épreuve (auto-ajout d'une valeur
saisie hors liste : matière, série...).
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy.orm import Session

from ..db_models import ReferentielOptionORM
from . import referentiel

log = logging.getLogger(__name__)

# Scopes administrés : chacun nomme une liste énumérative du back-office.
SCOPES = ("niveau", "classe", "evaluation", "matiere", "serie")

# Affiliation d'un scope à la colonne d'épreuve portant la valeur — servira
# au compteur « en usage » de l'interface Paramètres.
SCOPE_EPREUVE_COLONNE = {
    "niveau": "niveau",
    "classe": "classe",
    "evaluation": "evaluation",
    "matiere": "matiere",
}


def _seed_entries() -> list[dict]:
    """Entrées de seed (scope, code, label) extraites du référentiel —
    l'ajout d'une constante là-bas se reflète ici à la première création.
    `matiere` n'est PAS seedée : elle démarre vide et s'alimente à l'usage
    (auto-ajout des saisies d'épreuves)."""
    out: list[dict] = []
    for entry in referentiel.NIVEAUX:
        out.append({"scope": "niveau", "code": entry["code"], "label": entry.get("label", entry["code"])})
    for entry in referentiel.CLASSES_SECONDAIRE:
        out.append({"scope": "classe", "code": entry["code"], "label": entry.get("label", entry["code"])})
    for code in referentiel.EVALUATIONS:
        out.append({"scope": "evaluation", "code": code})
    for code in referentiel.SERIES_CONNUES:
        out.append({"scope": "serie", "code": code})
    return out


def seed_referentiel_options(db: Session) -> int:
    """Insère les options manquantes (idempotent — les options déjà
    présentes, y compris renommées par l'admin, ne sont pas touchées) puis
    purge les options appartenant à un scope AUJOURD'HUI retiré (ex. le
    scope « session » supprimé le 2026-09-18 : des valeurs comme
    « Session normale » auto-ajoutées avant la suppression restaient en
    base et ressortaient dans les listes back-office). Renvoie le nombre
    total d'options après seed."""
    for i, entry in enumerate(_seed_entries()):
        existing = (
            db.query(ReferentielOptionORM)
            .filter(
                ReferentielOptionORM.scope == entry["scope"],
                ReferentielOptionORM.code == entry["code"],
            )
            .one_or_none()
        )
        if existing is None:
            db.add(
                ReferentielOptionORM(
                    scope=entry["scope"],
                    code=entry["code"],
                    label=entry.get("label"),
                    position=i,
                )
            )
    purges = db.query(ReferentielOptionORM).filter(ReferentielOptionORM.scope.notin_(SCOPES)).delete(
        synchronize_session=False
    )
    if purges:
        log.info("Référentiel : %d option(s) de scope(s) retiré(s) purgée(s)", purges)
    db.commit()
    return db.query(ReferentielOptionORM).count()


def get_option(db: Session, scope: str, code: str) -> Optional[ReferentielOptionORM]:
    """Option d'un scope par sa valeur canonique (ou None)."""
    return (
        db.query(ReferentielOptionORM)
        .filter(ReferentielOptionORM.scope == scope, ReferentielOptionORM.code == code)
        .one_or_none()
    )


def ensure_option(db: Session, scope: str, code: str, label: Optional[str] = None) -> bool:
    """Ajoute une option (scope, code) si elle n'existe pas — créé=True.
    Sert d'auto-ajout quand un formulaire d'épreuve saisit une valeur hors
    liste (matière, série) ; l'échec éventuel est silencieux pour ne jamais
    bloquer l'enregistrement d'une épreuve."""
    if scope not in SCOPES:
        return False
    code = (code or "").strip()
    if not code:
        return False
    if get_option(db, scope, code) is not None:
        return False
    position = db.query(ReferentielOptionORM).filter(ReferentielOptionORM.scope == scope).count()
    db.add(ReferentielOptionORM(scope=scope, code=code, label=label, position=position))
    db.commit()
    return True