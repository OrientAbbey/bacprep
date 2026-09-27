"""Configuration transverse du backend.

Toute la configuration passe par des variables d'environnement (chargées
depuis ``backend/.env`` par ``main.py``) ; ce module centralise les
lectures transverses pour éviter que chaque routeur ne réinterprète
l'environnement à sa façon.
"""
from __future__ import annotations

import os

#: Valeur d'exemple interdite en production (cf. ``.env.example``). Source
#: unique : ``routers/admin_misc.py`` la refuse au login et ``main.py`` la
#: refuse au démarrage.
EXAMPLE_ADMIN_TOKEN = "admin123"

#: Longueur minimale du secret HMAC des URLs signées.
MIN_FILE_URL_SECRET_BYTES = 32


#: Seules ces valeurs activent le mode développement. Tout le reste — y
#: compris une variable absente, vide ou mal orthographiée (``production``,
#: ``PROD``, ``Prod``…) — est traité comme la production. Reconnaître les
#: alias évite le piège de ``== "prod"``, qui faisait passer ``ENV=production``
#: pour du développement et sautait du même coup toutes les vérifications.
_DEV_ENVIRONMENTS = {"dev", "devlocal", "development", "local", "test"}


def is_prod() -> bool:
    """Vrai en production.

    Le mode développement doit être **explicite** : ``ENV=dev``. Une variable
    ``ENV`` absente, vide ou mal orthographiée ne doit jamais faire basculer
    silencieusement le service en développement, qui autorise le mock-login,
    retire ``Secure`` du cookie de session et tolère le jeton admin
    d'exemple.

    Le mock de connexion reste gouverné par ``AUTH_MODE`` (indépendant de
    ``ENV``) pour ne pas casser les démonstrations hébergées.
    """
    return os.getenv("ENV", "prod").strip().lower() not in _DEV_ENVIRONMENTS


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
