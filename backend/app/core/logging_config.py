"""Rotating file + console logging, set up once at startup."""
from __future__ import annotations

import json
import logging
import os
from logging.handlers import RotatingFileHandler

from ..db import LOGS_DIR

_CONFIGURED = False

MAX_BYTES = 5 * 1024 * 1024  # 5 Mo
BACKUP_COUNT = 5


class JsonFormatter(logging.Formatter):
    """Une ligne JSON par évènement (LOG_FORMAT=json) : exploitable par les outils
    de logs de Render. Les champs passés via `extra={...}` sont ajoutés tels quels."""

    _STD = set(vars(logging.LogRecord("", 0, "", 0, "", None, None))) | {"message", "asctime", "taskName"}

    def format(self, record: logging.LogRecord) -> str:
        d = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "niveau": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        d.update({k: v for k, v in record.__dict__.items() if k not in self._STD and not k.startswith("_")})
        if record.exc_info:
            d["exception"] = self.formatException(record.exc_info)
        return json.dumps(d, ensure_ascii=False, default=str)


def log_json_actif() -> bool:
    return os.getenv("LOG_FORMAT", "text").strip().lower() == "json"


class _AccessQuietFilter(logging.Filter):
    """Filtre les lignes d'accès bruyantes émises par le serveur ASGI
    (uvicorn.access), sans perdre le reste des accès API :
      - le battement de cœur admin (POST /api/admin/heartbeat toutes les
        30 s tant que la console /admin est ouverte).
    On se fie au message rendu (méthode + chemin), pas aux positions des
    arguments du format d'uvicorn (version sensible)."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:
            return True
        if "/api/admin/heartbeat" in message:
            return False
        return True


def setup_logging() -> None:
    """Initialise les 3 handlers (app.log, errors.log, console) une seule
    fois — appelé au démarrage de main.py, sans effet si déjà appelé."""
    global _CONFIGURED
    if _CONFIGURED:
        return

    root = logging.getLogger("bacprep")
    root.setLevel(logging.INFO)
    root.propagate = False

    fmt: logging.Formatter = (
        JsonFormatter()
        if log_json_actif()
        else logging.Formatter("%(asctime)s | %(levelname)-8s | %(name)s | %(message)s")
    )

    app_handler = RotatingFileHandler(
        LOGS_DIR / "app.log", maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT, encoding="utf-8"
    )
    app_handler.setLevel(logging.INFO)
    app_handler.setFormatter(fmt)

    error_handler = RotatingFileHandler(
        LOGS_DIR / "errors.log", maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT, encoding="utf-8"
    )
    error_handler.setLevel(logging.WARNING)
    error_handler.setFormatter(fmt)

    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(fmt)

    root.addHandler(app_handler)
    root.addHandler(error_handler)
    root.addHandler(console_handler)

    # Diminue le bruit de journal du serveur ASGI : battement de cœur admin
    # (heartbeat toutes les 30 s). uvicorn configure ses handlers après nous
    # (dictConfig), mais les niveaux et filtres posés sur le logger sont
    # conservés — le filtre s'applique donc aussi à la sortie console par
    # défaut (`python -m uvicorn app.main:app`).
    _quiet = _AccessQuietFilter()
    for _name in ("uvicorn", "uvicorn.access"):
        logging.getLogger(_name).addFilter(_quiet)
    if log_json_actif():
        # Le middleware `journal_requete` (main.py) émet déjà UNE ligne JSON par
        # requête : on coupe l'accès texte d'uvicorn pour ne pas doubler.
        logging.getLogger("uvicorn.access").disabled = True

    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    """Logger nommé `bacprep.<name>`, héritant des handlers configurés par
    `setup_logging`."""
    return logging.getLogger(f"bacprep.{name}")
