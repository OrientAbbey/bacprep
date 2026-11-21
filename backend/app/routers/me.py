"""Compatibilité : les routes de profil vivent dans ``app.domains.comptes.api``.

Ancien chemin conservé pour les imports existants ; ``main.py`` inclut le
routeur du domaine.
"""
from __future__ import annotations

from ..domains.comptes.api import router  # noqa: F401
