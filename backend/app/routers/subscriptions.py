"""Compatibilité : les routes d'abonnement vivent dans
``app.domains.abonnements.api``. L'ancien chemin reste disponible pour les
imports existants ; ``main.py`` inclut le routeur du domaine.
"""
from __future__ import annotations

from ..domains.abonnements.api import router  # noqa: F401
