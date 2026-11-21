"""Compatibilité : le SEO vit désormais dans ``app.domains.catalogue.seo``.

L'ancien chemin d'import est conservé pour les scripts et extensions externes.
"""
from __future__ import annotations

from ..domains.catalogue.seo import *  # noqa: F401,F403
