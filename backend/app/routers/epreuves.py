"""Compatibilité : les routes d'épreuves vivent dans
``app.domains.catalogue.api``. L'ancien chemin reste disponible pour les
imports existants ; ``main.py`` inclut le routeur du domaine.
"""
from __future__ import annotations

from ..domains.catalogue.api import router  # noqa: F401
