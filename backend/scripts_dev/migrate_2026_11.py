"""Migration idempotente novembre 2026 — chantier « matricule + monnaie AK ».

Complète une base EXISTANTE restée au schéma d'avant le chantier :

- ``users.matricule`` — identifiant public dictable (index UNIQUE) ;
- ``users.solde_ak`` / ``ak_serie_jours`` / ``ak_dernier_jour`` — monnaie
  interne et série de connexions ;
- ``plans.prix_ak`` — prix en AK d'une formule (NULL = non payable en AK) ;
- ``payments.monnaie`` — ``"XAF"`` (défaut) ou ``"AK"``, pour que les
  agrégats financiers puissent exclure les achats en monnaie interne ;
- table ``ak_mouvements`` (journal signé, source de vérité comptable).

Puis rétrofill : un matricule pour chaque compte qui n'en a pas, et les
``prix_ak`` par défaut des formules existantes (le seed n'écrit jamais dans
une table ``plans`` déjà peuplée — voir ``core/plans.seed_plans``).

**Ces étapes sont désormais aussi appliquées au démarrage** par
``app.core.schema_migrations`` (voir ``main._migrer_schema``) : un déploiement
Render ne lançant aucun script manuel, une base en retard cassait `/api/pricing`
et la connexion. Ce script reste utile pour réparer une base hors ligne ou
rejouer la migration sans redémarrer le service.

Usage : cd backend && python -m scripts_dev.migrate_2026_11
"""

from __future__ import annotations

from sqlalchemy import inspect

from app.core.logging_config import get_logger
from app.core.schema_migrations import (
    assurer_index,
    reparer_schema,
    retrofill_matricules,
    retrofill_prix_ak,
)
from app.db import SessionLocal, engine
from app.db_models import Base

log = get_logger("migrate_2026_11")


def _creer_tables_absentes() -> list[str]:
    """`create_all` ne crée QUE les tables absentes (jamais de destructif)."""
    avant = set(inspect(engine).get_table_names())
    Base.metadata.create_all(engine)
    creees = set(inspect(engine).get_table_names()) - avant
    for table in sorted(creees):
        log.info("Table créée : %s", table)
    return sorted(creees)


def main() -> None:
    applique = reparer_schema(engine)
    tables = _creer_tables_absentes()
    index = assurer_index(engine)

    with SessionLocal() as db:
        matricules = retrofill_matricules(db)
    with SessionLocal() as db:
        prix_ak = retrofill_prix_ak(db)

    log.info(
        "Migration 2026-11 terminée — renommages : %s ; colonnes : %s ; tables : %s ; "
        "index créés : %s ; matricules attribués : %d ; prix AK complétés : %d",
        applique["renommees"] or "aucun (déjà à jour)",
        applique["ajoutees"] or "aucune (déjà à jour)",
        tables or "aucune (déjà à jour)",
        index or "aucun (déjà présents)",
        matricules,
        prix_ak,
    )


if __name__ == "__main__":
    main()
