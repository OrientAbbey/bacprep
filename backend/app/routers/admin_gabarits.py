"""Compatibilité : les routes admin des gabarits vivent dans
``app.domains.entrainement.api_admin``. L'ancien chemin reste disponible pour
les imports existants ; ``main.py`` inclut le routeur du domaine.
"""
from __future__ import annotations

from ..domains.entrainement.api_admin import router  # noqa: F401
