"""Compatibilité : ce module vit désormais dans ``app.domains.sauvegardes.jobs.definitions`` (alias ``sys.modules``)."""
from __future__ import annotations

import sys

from ..domains.sauvegardes.jobs import definitions as _reel

sys.modules[__name__] = _reel
