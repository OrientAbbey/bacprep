"""DTO du domaine Entraînement (entrées de l'API élève et admin)."""
from __future__ import annotations

from pydantic import BaseModel, Field

from . import moteur as gab


class SignalementIn(BaseModel):
    """Signalement d'une variante fautive : graine exacte et message libre de l'élève."""
    graine: int = Field(ge=0, le=gab.GRAINE_MAX)
    message: str = Field(default="", max_length=1000)
