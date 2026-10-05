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
    """`{x}` → un segment ; un dernier paramètre `{x}` peut couvrir plusieurs segments
    (routes `{cle:path}` : OpenAPI ne distingue pas le convertisseur `path`)."""
    parts = re.split(r"(\{[^}]*\})", route)
    dernier = max((i for i, x in enumerate(parts) if x.startswith("{")), default=-1)
    # Le paramètre est « dernier » s'il n'y a plus que du vide (le split laisse une chaîne vide) après lui.
    fin = dernier >= 0 and not any(parts[dernier + 1:])
    return re.compile("".join(
        (".+" if i == dernier and fin else "[^/]+") if x.startswith("{") else re.escape(x)
        for i, x in enumerate(parts)
    ) + "$")


def _routes_api() -> list[re.Pattern]:
    # OpenAPI (API publique de FastAPI) plutôt que `app.routes` : les versions récentes y
    # rangent des routeurs « paresseux » sans `.path`, et la liste dépendait de l'ordre des tests.
    # Le « fourre-tout » de l'application (`/{full_path}`, présent quand le frontend est compilé)
    # est exclu : il ne représente pas une route d'API et accepterait n'importe quel appel.
    return [
        _regex_route(re.sub(r"\{[^}]*\}", "{x}", p).rstrip("/"))
        for p in app_main.app.openapi()["paths"]
        if p.startswith("/api/") or p.startswith("/ws/")
    ]


def test_chaque_appel_frontend_a_une_route():
    routes = _routes_api()
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


def test_le_test_detecte_une_route_manquante():
    """Garde-fou du garde-fou : une route inventée doit être signalée."""
    routes = _routes_api()
    assert not any(r.match(_normaliser("/api/route-inventee/${id}")) for r in routes)
    assert any(r.match(_normaliser("/api/epreuves/${id}/signalements")) for r in routes)
