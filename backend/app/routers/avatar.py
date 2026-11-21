"""Compatibilité : les routes d'avatar vivent dans
``app.domains.comptes.api_avatar``. Ancien chemin conservé pour les imports
existants ; ``main.py`` inclut le routeur du domaine.
"""
from __future__ import annotations

from ..domains.comptes.api_avatar import router  # noqa: F401
