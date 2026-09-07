"""Configuration transverse du backend.

Toute la configuration passe par des variables d'environnement (chargées
depuis ``backend/.env`` par ``main.py``) ; ce module centralise les
lectures transverses pour éviter que chaque routeur ne réinterprète
l'environnement à sa façon.
"""
from __future__ import annotations

import os


def is_prod() -> bool:
    """Vrai en production (``ENV=prod`` — positionné dans render.yaml).
    Sert à durcir les comportements sensibles : cookie ``Secure``,
    refus du jeton admin d'exemple, etc. Le mode mock de connexion reste
    gouverné par ``AUTH_MODE`` (indépendant de ENV) pour ne pas casser
    les démonstrations hébergées."""
    return os.getenv("ENV", "dev").strip().lower() == "prod"


def demo_mode() -> bool:
    """Vrai quand les fonctionnalités de démonstration sont explicitement
    autorisées (``DEMO_MODE=true``) : connexion simulée sans preuve de
    possession, webhook de paiement simulé. En ``ENV=prod`` ces surfaces
    sont refusées SAUF si ce flag est posé volontairement (démo publique
    hébergée, cf. render.yaml) — jamais par défaut."""
    return os.getenv("DEMO_MODE", "").strip().lower() == "true"


def demo_allowed() -> bool:
    """Garde commun des endpoints de démo : autorisé hors production, ou
    en production avec le flag explicite ``DEMO_MODE=true``."""
    return not is_prod() or demo_mode()
