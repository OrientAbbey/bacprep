"""Import massif en ligne de commande — zone d'import locale.

Dépose un dossier organisé sous la zone d'import (défaut
``backend/data/imports/``) :

```
backend/data/imports/
└── 2023/
    └── Terminale/
        └── Mathématiques/
            ├── bac-D-sujet.md
            ├── bac-D-corrige.md
            └── figure1.png
```

puis lance :

```bash
python -m app.scripts.importer                 # import réel
python -m app.scripts.importer --dry-run      # simulation (aucune écriture)
python -m app.scripts.importer --dir chemin/vers/dossier
```

Le script parcourt récursivement les dossiers, identifie les fichiers
Markdown et images, récupère les informations depuis l'arborescence, crée
les entrées en base, copie les fichiers vers le stockage définitif, génère
les storage_key, détecte les doublons et signale les métadonnées
insuffisantes (voir `core/import_service.py`).
"""
from __future__ import annotations

import argparse
import json
import sys

from ..core.import_service import run_import
from ..core.logging_config import setup_logging
from ..db import IMPORTS_DIR, SessionLocal, Base, engine


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.scripts.importer",
        description="Import massif d'épreuves Markdown + images depuis un dossier organisé.",
    )
    parser.add_argument(
        "--dir",
        default=str(IMPORTS_DIR),
        help=f"Dossier à importer (défaut : zone d'import {IMPORTS_DIR})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Analyse sans écrire : liste ce qui serait créé/importé",
    )
    args = parser.parse_args(argv)

    setup_logging()

    # Crée les tables si nécessaire (le script peut être lancé avant le
    # premier démarrage du backend) puis initialise le seed éventuel.
    Base.metadata.create_all(bind=engine)

    root = __import__("pathlib").Path(args.dir)
    print(f"Import {'(simulation) ' if args.dry_run else ''}de : {root}")

    db = SessionLocal()
    try:
        report = run_import(db, root, dry_run=args.dry_run)
    finally:
        db.close()

    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report.get("erreurs"):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
