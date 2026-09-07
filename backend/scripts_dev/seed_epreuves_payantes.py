"""Seed de démonstration : crée (idempotent) deux épreuves PAYANTES
publiées, avec sujet + corrigé, pour éprouver le paywall et le mode
visiteur sur la base de développement. Réutilise la règle d'unicité de
l'import massif (niveau/classe/évaluation/matière/année/série) : si une
épreuve identique existe déjà, elle est laissée telle quelle.

Usage : cd backend && python -m scripts_dev.seed_epreuves_payantes
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.core import epreuve_files, referentiel
from app.core.logging_config import get_logger
from app.db import SessionLocal
from app.db_models import EpreuveFiliereORM, EpreuveORM

log = get_logger("seed_payantes")

SEEDS = [
    {
        "niveau": "SECONDAIRE",
        "classe": "terminale",
        "evaluation": "BAC",
        "matiere": "Mathématiques",
        "annee": "2022",
        "session": "",
        "duree": "3h",
        "coefficient": "5",
        "filieres": ["C", "D"],
        "sujet": (
            "# BAC 2022 — Mathématiques (séries C et D)\n\n"
            "**Exercice 1 — Suites.** Soit la suite $(u_n)$ définie par "
            "$u_0 = 2$ et $u_{n+1} = \\dfrac{1}{2}u_n + 3$.\n\n"
            "1. Montrer que $(u_n)$ est convergente.\n"
            "2. Déterminer sa limite.\n\n"
            "**Exercice 2 — Probabilités.** Une urne contient 5 boules rouges et 3 boules noires. "
            "On tire successivement et sans remise deux boules. Calculer la probabilité "
            "d'obtenir deux boules de même couleur."
        ),
        "corrige": (
            "# Corrigé — BAC 2022 Mathématiques\n\n"
            "**Exercice 1.** La suite est arithmético-géométrique : le point fixe est "
            "$\\ell = 6$. La suite $(u_n - 6)$ est géométrique de raison $\\tfrac{1}{2}$, "
            "donc $u_n \\to 6$.\n\n"
            "**Exercice 2.** $P(\\text{même couleur}) = \\dfrac{5}{8}\\cdot\\dfrac{4}{7} "
            "+ \\dfrac{3}{8}\\cdot\\dfrac{2}{7} = \\dfrac{26}{56} = \\dfrac{13}{28}$."
        ),
    },
    {
        "niveau": "SECONDAIRE",
        "classe": "1ere",
        "evaluation": "PROBATOIRE",
        "matiere": "Physique-Chimie",
        "annee": "2023",
        "session": "",
        "duree": "3h",
        "coefficient": "4",
        "filieres": ["C", "D"],
        "sujet": (
            "# Probatoire 2023 — Physique-Chimie (séries C et D)\n\n"
            "**Partie A — Mécanique.** Un mobile de masse $m = 2$ kg glisse sans frottement "
            "sur un plan incliné de 30°. Calculer son accélération ($g = 10$ N/kg).\n\n"
            "**Partie B — Chimie.** On dissout 4 g de NaOH dans 500 mL d'eau. "
            "Calculer la concentration molaire ($M_{NaOH} = 40$ g/mol)."
        ),
        "corrige": (
            "# Corrigé — Probatoire 2023 Physique-Chimie\n\n"
            "**Partie A.** $a = g\\sin\\theta = 10 \\times 0{,}5 = 5$ m/s².\n\n"
            "**Partie B.** $n = \\dfrac{4}{40} = 0{,}1$ mol ; "
            "$C = \\dfrac{0{,}1}{0{,}5} = 0{,}2$ mol/L."
        ),
    },
]


def _existe(db: Session, seed: dict) -> EpreuveORM | None:
    return (
        db.query(EpreuveORM)
        .filter(
            EpreuveORM.niveau == seed["niveau"],
            EpreuveORM.classe == seed["classe"],
            EpreuveORM.evaluation == seed["evaluation"],
            EpreuveORM.matiere == seed["matiere"],
            EpreuveORM.annee == seed["annee"],
        )
        .one_or_none()
    )


def main() -> None:
    from app.core import extraits

    creees = 0
    with SessionLocal() as db:
        for seed in SEEDS:
            if _existe(db, seed):
                log.info("Déjà présente, ignorée : %s %s %s %s", seed["classe"], seed["evaluation"], seed["matiere"], seed["annee"])
                continue
            e = EpreuveORM(
                niveau=seed["niveau"],
                classe=seed["classe"],
                evaluation=seed["evaluation"],
                matiere=seed["matiere"],
                annee=seed["annee"],
                session=seed["session"],
                duree=seed["duree"],
                coefficient=seed["coefficient"],
                gratuit=False,  # PAYANTES : servent à éprouver le paywall
                statut="publie",
                extrait=extraits.build_extrait(seed["sujet"]),
            )
            db.add(e)
            db.flush()
            epreuve_files.write_document(db, e, "sujet", seed["sujet"])
            epreuve_files.write_document(db, e, "corrige", seed["corrige"])
            for f in seed["filieres"]:
                db.add(EpreuveFiliereORM(epreuve_id=e.id, filiere=f))
            creees += 1
            log.info("Épreuve payante créée : %s %s %s (%s)", e.id, e.matiere, e.evaluation, e.annee)
        db.commit()
    log.info("Seed terminé — %d épreuve(s) créée(s)", creees)


if __name__ == "__main__":
    main()
