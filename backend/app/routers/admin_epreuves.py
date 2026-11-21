"""Compatibilité : ce module vit désormais dans ``app.domains.epreuves_admin.api_epreuves``.

L'ancien chemin est un alias ``sys.modules`` du module réel : les imports
existants et les monkeypatchs portent sur le même objet.
"""
from __future__ import annotations

import sys

from ..domains.epreuves_admin import api_epreuves as _reel

sys.modules[__name__] = _reel
