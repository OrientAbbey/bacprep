"""Approbation d'un plan d'actions admin, liée à son contenu exact.

Le modèle propose un plan ; le serveur signe ce plan (ainsi que l'admin,
l'heure et un nonce) avec un HMAC. Le client ne renvoie que ce jeton opaque :
il ne peut donc ni modifier les arguments approuvés, ni rejouer une
approbation plus tard. Toute vérification infructueuse lève `ValueError` —
l'appelant doit alors **fail closed** (aucune action exécutée).

Le secret vient de `ADMIN_APPROBATION_SECRET`. À défaut, un secret aléatoire
est généré par processus : les jetons ne survivent pas à un redémarrage, ce
qui est acceptable au regard de leur courte durée de validité. En
multi-instance, définir la variable d'environnement est obligatoire.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any

DUREE_VALIDITE_SECONDS = 300  # 5 minutes
MAX_NONCES_GARDES = 5_000

_SECRET = (os.getenv("ADMIN_APPROBATION_SECRET") or "").encode("utf-8")
if not _SECRET:
    _SECRET = secrets.token_bytes(32)

# Anti-rejeu en mémoire (mono-instance, comme le limiteur de l'assistant).
_NONCES: dict[str, float] = {}


def _canonical(actions: list[dict]) -> str:
    """Sérialisation déterministe des actions approuvées."""

    def propre(value: Any) -> Any:
        """Normalise une valeur en structure JSON sûre à signer (sans clés internes)."""
        if isinstance(value, dict):
            return {k: propre(value[k]) for k in sorted(value)}
        if isinstance(value, list):
            return [propre(v) for v in value]
        return value

    return json.dumps(propre(actions), ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _deb64(texte: str) -> bytes:
    return base64.urlsafe_b64decode(texte + "=" * (-len(texte) % 4))


def _signature(payload: dict) -> str:
    brut = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return _b64(hmac.new(_SECRET, brut, hashlib.sha256).digest())


def _nettoyer_nonces(maintenant: float) -> None:
    for nonce, expire in list(_NONCES.items()):
        if expire < maintenant:
            _NONCES.pop(nonce, None)


def creer(admin: str, actions: list[dict]) -> str:
    """Crée un jeton lié à `admin` et aux `actions` exactes."""
    maintenant = time.time()
    _nettoyer_nonces(maintenant)
    nonce = secrets.token_urlsafe(16)
    payload = {
        "admin": admin,
        "actions": _canonical(actions),
        "iat": int(maintenant),
        "exp": int(maintenant) + DUREE_VALIDITE_SECONDS,
        "nonce": nonce,
    }
    _NONCES[nonce] = payload["exp"]
    if len(_NONCES) > MAX_NONCES_GARDES:
        for ancien in sorted(_NONCES, key=_NONCES.get)[: len(_NONCES) - MAX_NONCES_GARDES]:
            _NONCES.pop(ancien, None)
    return f"{_b64(json.dumps(payload, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode('utf-8'))}.{_signature(payload)}"


def verifier(jeton: str, admin: str, actions: list[dict]) -> None:
    """Vérifie le jeton pour cet admin et ces actions. Lève `ValueError` sinon."""
    try:
        donnees, sig = jeton.split(".", 1)
        payload = json.loads(_deb64(donnees))
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError("Jeton d'approbation invalide") from exc
    if not isinstance(payload, dict) or not hmac.compare_digest(_signature(payload), sig):
        raise ValueError("Jeton d'approbation invalide")
    if payload.get("admin") != admin:
        raise ValueError("Approbation émise pour un autre administrateur")
    if payload.get("actions") != _canonical(actions):
        raise ValueError("Les actions ont été modifiées depuis l'approbation")
    if not isinstance(payload.get("exp"), (int, float)) or time.time() > payload["exp"]:
        raise ValueError("Approbation expirée — relance la demande")
    nonce = payload.get("nonce")
    if not isinstance(nonce, str) or nonce not in _NONCES:
        raise ValueError("Approbation inconnue ou déjà utilisée")
    _NONCES.pop(nonce, None)  # consommation : rejeu impossible
