"""Rate limiting mémoire à fenêtre glissante, partagé par les endpoints
sensibles (logins admin/élève, assistant IA).

Limitation assumée : les compteurs vivent dans la mémoire du processus —
suffisant pour le déploiement single-instance (Render) ; derrière plus
d'un worker/instance chaque processus compte ses propres tentatives et
le plafond effectif devient ``max × instances``. Un store partagé
(Redis) serait nécessaire pour un vrai plafond global.
"""
from __future__ import annotations

import os
import time

from fastapi import HTTPException, Request


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
        attempts = [t for t in self._attempts.get(key, []) if now - t < self._window]
        if len(attempts) >= self._max:
            self._attempts[key] = attempts
            raise HTTPException(429, self._message)
        attempts.append(now)
        self._attempts[key] = attempts

    def reset(self) -> None:
        """Vide les compteurs (usage : tests)."""
        self._attempts.clear()


def client_ip(request: Request) -> str:
    """Clé de comptage : IP cliente telle que vue par le serveur (les
    proxies Render positionnent X-Forwarded-For, que uvicorn ne fait pas
    suivre dans request.client — compter l'IP socket reste suffisant pour
    freiner un brute-force depuis une même source)."""
    return request.client.host if request.client else "?"
