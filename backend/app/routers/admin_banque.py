"""Compatibilité : ce module vit désormais dans ``app.domains.banque.api_admin``.

L'ancien chemin est un alias ``sys.modules`` du module réel : les imports
existants et les monkeypatchs portent sur le même objet.
"""
from __future__ import annotations

import sys

from ..domains.banque import api_admin as _reel

sys.modules[__name__] = _reel
