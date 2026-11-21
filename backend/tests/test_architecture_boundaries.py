"""Contraintes d'architecture : dépendances orientées et absence de cycle.

Ces tests échouent quand une couche inférieure recommence à importer une
couche supérieure, ou quand un cycle d'imports réapparaît entre le runner
et la file de jobs. Ils complètent ``test_contrat_routes.py`` (contrat HTTP).
"""
from __future__ import annotations

import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"


def _imports(chemin: Path) -> list[str]:
    arbre = ast.parse(chemin.read_text(encoding="utf-8"))
    cibles: list[str] = []
    for noeud in ast.walk(arbre):
        if isinstance(noeud, ast.ImportFrom) and noeud.module:
            cibles.append(noeud.module)
        elif isinstance(noeud, ast.Import):
            cibles.extend(a.name for a in noeud.names)
    return cibles


def test_core_ne_depend_pas_des_routers():
    """Le noyau technique ne doit pas importer la couche HTTP.

    Exception transitoire documentée : ``core/admin_tools.py`` importe
    encore des modèles définis dans les routeurs ; elle sera supprimée en
    phase 4 (domaine ``assistant``).
    """
    exceptions = {"admin_tools.py"}
    coupables: list[str] = []
    for chemin in sorted((APP / "core").glob("*.py")):
        if chemin.name in exceptions:
            continue
        for module in _imports(chemin):
            if module in {"routers", "app.routers"} or module.startswith(("..routers", ".routers")):
                coupables.append(f"{chemin.name} -> {module}")
    assert not coupables, "core dépend de routers : " + ", ".join(coupables)


def test_admin_tools_est_la_seule_dette_vers_les_routers():
    """La dette connue ne doit pas se propager à d'autres modules core."""
    avec_routers = sorted(
        chemin.name
        for chemin in (APP / "core").glob("*.py")
        if any(m in {"routers", "app.routers"} or m.startswith(("..routers", ".routers")) for m in _imports(chemin))
    )
    assert avec_routers == ["admin_tools.py"], f"dette inattendue vers routers : {avec_routers}"


def test_runner_et_file_ne_forment_pas_de_cycle():
    """``WORKER_ID`` vit dans un module feuille, pas dans l'un des deux."""
    runner = APP / "core" / "job_runner.py"
    file_jobs = APP / "core" / "job_queue.py"
    definitions = APP / "core" / "job_definitions.py"
    assert definitions.exists(), "core/job_definitions.py est requis"
    assert "WORKER_ID" in definitions.read_text(encoding="utf-8")
    for chemin in (runner, file_jobs):
        modules = _imports(chemin)
        if chemin == runner:
            assert not any(m.endswith("job_queue") for m in modules), "job_runner importe job_queue (cycle)"
        # La file peut importer le runner (sens unique) ; le runner ne doit jamais
        # importer la file, même en différé dans une fonction.
        assert any(m.endswith("job_definitions") for m in modules), f"{chemin.name} doit importer job_definitions"
