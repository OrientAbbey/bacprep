"""Compatibilité : le moteur de gabarits vit désormais dans le domaine
``app.domains.entrainement.moteur``. Ce module conserve l'ancien chemin
d'import pour les scripts et extensions externes.
"""
from __future__ import annotations

from ..domains.entrainement.moteur import *  # noqa: F401,F403
from ..domains.entrainement.moteur import _CACHE, charger_dossier  # noqa: F401
