"""Compatibilité : les routes d'authentification vivent dans
``app.domains.comptes.api_auth``. Ancien chemin conservé pour les tests et
scripts ; ``main.py`` inclut le routeur du domaine.
"""
from __future__ import annotations

from ..domains.comptes.api_auth import (  # noqa: F401
    _login_limiter,
    optional_user,
    require_user,
    router,
)
