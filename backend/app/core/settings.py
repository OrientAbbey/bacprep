"""Vue typée et validée de la configuration.

Les fonctions historiques de ``core/config.py`` (``is_prod``, ``demo_mode``…)
lisent l'environnement à l'appel : elles sont conservées telles quelles pour ne
pas casser les tests qui modifient ``os.environ``. Ce module propose une
**photo validée** de la configuration pour le nouveau code et les cas d'usage
qui ont besoin de plusieurs valeurs cohérentes entre elles.

Aucune dépendance supplémentaire : Pydantic est déjà présent.
"""
from __future__ import annotations

import os

from pydantic import BaseModel, Field


class Settings(BaseModel):
    """Configuration de base, lue depuis l'environnement au moment de la création."""

    environnement: str = Field(default_factory=lambda: os.getenv("ENV", "prod").strip().lower())
    mode_demo: bool = Field(default_factory=lambda: os.getenv("DEMO_MODE", "").strip().lower() == "true")
    mode_auth: str = Field(default_factory=lambda: os.getenv("AUTH_MODE", "google").strip().lower())
    racine_admin: str = Field(default="", description="E-mail de l'administrateur racine")
    base_donnees: str = Field(default="", description="URL SQLAlchemy (vide = défaut du module db)")
    backend_stockage: str = Field(default_factory=lambda: os.getenv("STORAGE_BACKEND", "local").strip().lower())
    secret_urls_fichiers: str = Field(default="", description="Secret HMAC des URL signées")

    @classmethod
    def depuis_environnement(cls) -> Settings:
        """Construit une photo validée de la configuration courante."""
        return cls(
            racine_admin=os.getenv("ADMIN_ROOT", ""),
            base_donnees=os.getenv("DATABASE_URL", ""),
            secret_urls_fichiers=os.getenv("FILE_URL_SECRET", ""),
        )

    @property
    def est_production(self) -> bool:
        """Vrai sauf si l'environnement est explicitement un environnement de dev."""
        return self.environnement not in {"dev", "devlocal", "development", "local", "test"}
