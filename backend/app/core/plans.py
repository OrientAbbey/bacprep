"""Compatibilité : les formules vivent dans ``app.domains.abonnements.plans``.

Ancien chemin conservé pour l'amorçage dans ``main.py`` et les migrations de
schéma.
"""
from __future__ import annotations

from ..domains.abonnements.plans import *  # noqa: F401,F403
from ..domains.abonnements.plans import _DEFAUTS_AK  # noqa: F401
