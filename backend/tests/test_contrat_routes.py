"""Contrat frontend ↔ backend : chaque chemin `/api/...` écrit dans les
sources du frontend doit correspondre à une route de l'API (OpenAPI)."""
from __future__ import annotations

import re
from pathlib import Path

import app.main as app_main

SRC = Path(__file__).resolve().parents[2] / "frontend" / "src"
LITTERAL = re.compile(r"""[`"'](/api/[^`"'\s]*)[`"']""")


def _normaliser(chemin: str) -> str:
    chemin = chemin.split("?")[0]
    chemin = re.sub(r"\$\{[^}]*\}", "{}", chemin)
    chemin = re.sub(r"\{[^}]*\}", "{}", chemin)
    return chemin.rstrip("/")


def _regex_route(route: str) -> re.Pattern:
    """`{x}` → un segment ; `{x:path}` → le reste du chemin."""
    parts = re.split(r"(\{[^}]*\})", route)
    return re.compile("".join(
        (".+" if ":path" in x else "[^/]+") if x.startswith("{") else re.escape(x) for x in parts
    ) + "$")


def test_chaque_appel_frontend_a_une_route():
    # `route.path` conserve les convertisseurs (`{cle:path}`), contrairement à OpenAPI.
    routes = [_regex_route(r.path.rstrip("/")) for r in app_main.app.routes if hasattr(r, "path")]
    manquants = []
    for f in SRC.rglob("*.ts*"):
        if ".test." in f.name:
            continue
        for m in LITTERAL.finditer(f.read_text(encoding="utf-8")):
            brut = m.group(1)
            # Préfixe construit dynamiquement ("/api/files/", "/api/...") : ignoré.
            if brut.endswith("/") or brut.endswith("..."):
                continue
            chemin = _normaliser(brut)
            # Chaîne de requête ajoutée par concaténation (`/api/x${qs}`).
            candidats = {chemin, re.sub(r"(?<=[^/])\{\}$", "", chemin)}
            if not any(r.match(c) for r in routes for c in candidats):
                manquants.append(f"{f.relative_to(SRC)}: {m.group(1)}")
    assert not manquants, "Routes appelées mais absentes de l'API :\n" + "\n".join(manquants)
