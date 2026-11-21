"""Compatibilité : les règles d'abonnement vivent dans
``app.domains.abonnements.regles``. Ancien chemin conservé pour les imports
existants (routers `me`, tests, scripts).
"""
from __future__ import annotations

from ..domains.abonnements.regles import *  # noqa: F401,F403
