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


def _importe_routers(module: str) -> bool:
    return module in {"routers", "app.routers"} or module.startswith(("..routers", ".routers", "...routers"))


def test_core_ne_depend_pas_des_routers():
    """Le noyau technique ne doit jamais importer la couche HTTP.

    La dette transitoire ``core/admin_tools.py`` a été supprimée en phase 4 :
    le module vit désormais dans ``domains/assistant`` et n'a plus d'exception.
    """
    coupables: list[str] = []
    for chemin in sorted((APP / "core").glob("*.py")):
        for module in _imports(chemin):
            if _importe_routers(module):
                coupables.append(f"{chemin.name} -> {module}")
    assert not coupables, "core dépend de routers : " + ", ".join(coupables)


def test_admin_tools_n_importe_plus_les_routeurs_admin():
    """L'inversion corrigée en phase 4 ne doit pas réapparaître.

    ``domains/assistant/admin_tools.py`` appelle les cas d'usage des domaines
    (banque, épreuves, formules, sauvegardes, communication) au lieu des
    routeurs. Seul le référentiel, contrat partagé resté sous ``routers``,
    peut encore être importé.
    """
    chemin = APP / "domains" / "assistant" / "admin_tools.py"
    modules = _imports(chemin)
    interdits = {
        "admin_banque", "admin_epreuves", "admin_gabarits", "admin_misc",
        "admin_notifications", "admin_plans", "admin_sauvegardes", "calendrier",
    }
    trouves = sorted(
        module for module in modules
        if _importe_routers(module) and module.split(".")[-1] in interdits
    )
    assert not trouves, f"admin_tools dépend encore de routeurs admin : {trouves}"


def test_runner_et_file_ne_forment_pas_de_cycle():
    """``WORKER_ID`` vit dans un module feuille, pas dans l'un des deux."""
    jobs = APP / "domains" / "sauvegardes" / "jobs"
    runner = jobs / "runner.py"
    file_jobs = jobs / "queue.py"
    definitions = jobs / "definitions.py"
    assert definitions.exists(), "domains/sauvegardes/jobs/definitions.py est requis"
    assert "WORKER_ID" in definitions.read_text(encoding="utf-8")
    for chemin in (runner, file_jobs):
        modules = _imports(chemin)
        if chemin == runner:
            assert not any(m.endswith("job_queue") for m in modules), "job_runner importe job_queue (cycle)"
        # La file peut importer le runner (sens unique) ; le runner ne doit jamais
        # importer la file, même en différé dans une fonction.
        assert any(m.endswith("definitions") for m in modules), f"{chemin.name} doit importer le module des définitions partagées"
