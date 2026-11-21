"""Compatibilité : les routes d'entraînement vivent dans
``app.domains.entrainement.api``. L'ancien chemin reste disponible pour les
imports existants ; ``main.py`` inclut le routeur du domaine.
"""
from __future__ import annotations

from ..domains.entrainement.api import _limiter, _signal_limiter, router  # noqa: F401
