"""Compatibilité : la monnaie AK vit dans ``app.domains.abonnements.ak``.

Ancien chemin conservé pour les imports existants (tests, scripts de
vérification d'invariant).
"""
from __future__ import annotations

from ..domains.abonnements.ak import *  # noqa: F401,F403
