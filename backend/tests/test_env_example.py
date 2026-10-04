"""Chaque variable d'environnement lue par le code doit figurer dans
`.env.example` (active ou commentée) : le fichier reste la référence."""
from __future__ import annotations

import re
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
LECTURE = re.compile(r"""(?:os\.getenv|os\.environ\.get|getenv)\(\s*["']([A-Z][A-Z0-9_]+)["']|os\.environ\[\s*["']([A-Z][A-Z0-9_]+)["']""")
# Fournies par la plateforme (Render) ou purement internes aux tests.
IGNOREES = {"PORT", "RENDER", "RENDER_EXTERNAL_URL", "RENDER_EXTERNAL_HOSTNAME", "PYTEST_CURRENT_TEST", "TEST_DATABASE_URL"}


def test_variables_lues_documentees():
    documentees = set(re.findall(r"^#?\s*([A-Z][A-Z0-9_]+)=", (RACINE / ".env.example").read_text(encoding="utf-8"), re.M))
    lues: dict[str, str] = {}
    for f in (RACINE / "app").rglob("*.py"):
        for m in LECTURE.finditer(f.read_text(encoding="utf-8")):
            lues.setdefault(m.group(1) or m.group(2), str(f.relative_to(RACINE)))
    manquantes = {k: v for k, v in lues.items() if k not in documentees and k not in IGNOREES}
    assert not manquantes, "Variables absentes de .env.example :\n" + "\n".join(f"  {k}  ({v})" for k, v in sorted(manquantes.items()))
