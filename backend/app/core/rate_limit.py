"""Rate limiting mémoire à fenêtre glissante, partagé par les endpoints
sensibles (logins admin/élève, assistant IA).

Limitation assumée : les compteurs vivent dans la mémoire du processus —
suffisant pour le déploiement single-instance (Render) ; derrière plus
d'un worker/instance chaque processus compte ses propres tentatives et
le plafond effectif devient ``max × instances``. Un store partagé
(Redis) serait nécessaire pour un vrai plafond global.
"""
from __future__ import annotations

import ipaddress
import os
import time

from fastapi import HTTPException, Request

from .config import is_prod
from .logging_config import get_logger

log = get_logger("rate_limit")

MAX_TRACKED_KEYS = 10_000


class SlidingWindowLimiter:
    """Compteur par clé (typiquement l'IP cliente) avec purge des
    entrées expirées à chaque appel."""

    def __init__(
        self,
        max_attempts: int,
        window_seconds: float,
        message: str = "Trop de tentatives — réessaie plus tard",
        env_switch: str | None = None,
    ) -> None:
        self._max = max_attempts
        self._window = window_seconds
        self._message = message
        # ex. LOGIN_RATE_LIMIT=0 désactive le limiteur (tests automatisés)
        self._env_switch = env_switch
        self._attempts: dict[str, list[float]] = {}

    def _enabled(self) -> bool:
        if not self._env_switch:
            return True
        return os.getenv(self._env_switch, "1").strip().lower() not in ("0", "off", "false")

    def check(self, key: str) -> None:
        """Compte une tentative pour ``key`` et lève 429 si le plafond de
        la fenêtre est déjà atteint."""
        if not self._enabled():
            return
        now = time.monotonic()
        if len(self._attempts) >= MAX_TRACKED_KEYS // 2:
            self._purge(now)
        if len(self._attempts) >= MAX_TRACKED_KEYS:
            self._evict_oldest(now)
        attempts = [t for t in self._attempts.get(key, []) if now - t < self._window]
        if len(attempts) >= self._max:
            self._attempts[key] = attempts
            raise HTTPException(429, self._message)
        attempts.append(now)
        self._attempts[key] = attempts

    def _purge(self, now: float) -> None:
        """Retire les clés dont la dernière tentative est hors fenêtre.

        Sans ce balayage, une clé jamais revisitée (IP forgée, cf.
        ``client_ip``) garderait ses horodatages jusqu'au redémarrage du
        process. Le seuil à mi-capacité rend le coût amorti O(1).
        """
        for stale in [k for k, ts in self._attempts.items() if not ts or now - ts[-1] >= self._window]:
            del self._attempts[stale]

    def _evict_oldest(self, now: float, low_water: float = 0.9) -> None:
        """Borne la mémoire en évictant les clés les plus anciennes.

        Le balayage ci-dessus ne suffit pas : si le seuil est atteint avec des
        clés toutes fraiches (attaque par rotation d'IP), le dictionnaire
        continuerait de grossir jusqu'à épuiser la mémoire du worker. On
        ramène donc sous la marque basse, en sacrifiant les entrées les
        moins récemment utilisées.

        Contrepartie assumée : une IP ainsi évictée retrouve un quota neuf.
        C'est le compromis habituel entre mémoire bornée et quasi-contournement
        par rotation d'IP — l'épuisement de la mémoire, lui, n'a pas de
        repli. ``log`` rend l'éviction visible pour l'alerte en production.
        """
        if len(self._attempts) < MAX_TRACKED_KEYS:
            return
        cible = int(MAX_TRACKED_KEYS * low_water)
        # Tri par dernière activité : les entrées les plus anciennes d'abord.
        par_anciennete = sorted(self._attempts.items(), key=lambda kv: kv[1][-1] if kv[1] else 0.0)
        for cle, _ in par_anciennete[: len(self._attempts) - cible]:
            del self._attempts[cle]
        log.warning(
            "Rate limiter saturé (%d clés actives) : éviction des plus anciennes pour rester sous %d",
            len(par_anciennete),
            cible,
        )

    def reset(self) -> None:
        """Vide les compteurs (usage : tests)."""
        self._attempts.clear()


def _valid_ip(value: str) -> str | None:
    """Normalise une adresse IP, ou ``None`` si la valeur n'en est pas une."""
    candidate = value.strip()
    if not candidate:
        return None
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return None


def client_ip(request: Request) -> str:
    """Clé de comptage : l'IP cliente.

    En production, compter l'IP socket (``request.client``) donnerait la MÊME
    clé pour tous les clients (l'adresse du proxy) : un seuil global trivial
    à saturer, qui bloquerait le login de tout le monde.

    Le choix de l'en-tête est donc normatif. On privilégie ``True-Client-Ip``
    puis ``CF-Connecting-IP``, en supposant que le proxy de bord les pose
    lui-même et écrase toute valeur fournie par le client. Cette confiance
    est une hypothèse de configuration, pas une garantie du code : si le
    proxy ne réécrit pas ces en-têtes, un attaquant peut les forger et
    obtenir un quota neuf aussi facilement qu'en variant ``X-Forwarded-For``.
    À vérifier donc lors du déploiement (une requête de contrôle doit
    renvoyer l'IP du client et non une valeur choisie par lui).

    ``X-Forwarded-For`` n'est utilisé qu'en dernier recours : un proxy
    inverse **ajoute** l'adresse réelle à la fin d'un en-tête fourni par le
    client au lieu de la remplacer, donc l'entrée la plus à gauche est celle
    que l'attaquant choisit. Prendre ``split(",")[0]`` rendait le quota
    contournable en une ligne ; on prend donc la plus à DROITE. Si aucune
    valeur n'est une IP valide, on retombe sur l'IP socket.
    """
    if is_prod():
        # TRUST_CLIENT_IP_HEADERS=0 si un contrôle (GET /api/health/ip avec un
        # faux True-Client-IP) montre que le proxy ne réécrit pas ces en-têtes.
        if os.getenv("TRUST_CLIENT_IP_HEADERS", "1").strip().lower() not in ("0", "off", "false"):
            for header in ("true-client-ip", "cf-connecting-ip"):
                normalised = _valid_ip(request.headers.get(header, ""))
                if normalised:
                    return normalised
        # TRUSTED_PROXY_HOPS : nombre de proxys de confiance devant l'app ;
        # on lit l'entrée située à cette distance depuis la DROITE.
        try:
            saut = max(1, int(os.getenv("TRUSTED_PROXY_HOPS", "1")))
        except ValueError:
            saut = 1
        forwarded = request.headers.get("x-forwarded-for", "")
        hops = [_valid_ip(part) for part in forwarded.split(",")]
        if len(hops) >= saut and hops[-saut]:
            return hops[-saut]
        for hop in reversed(hops):
            if hop:
                return hop
    socket_host = request.client.host if request.client else None
    return _valid_ip(socket_host or "") or "unknown"
