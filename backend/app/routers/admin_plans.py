"""Compatibilité : les routes admin des formules vivent dans
``app.domains.abonnements.api_admin``. Ancien chemin conservé pour les imports
existants (notamment ``core.admin_tools``) ; ``main.py`` inclut le routeur du
domaine.
"""
from __future__ import annotations

from ..domains.abonnements.api_admin import (  # noqa: F401
    PlanIn,
    PlanUpdate,
    creer,
    modifier,
    router,
    supprimer,
)
