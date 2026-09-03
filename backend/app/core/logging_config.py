"""Rotating file + console logging, set up once at startup."""
from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler

from ..db import LOGS_DIR

_CONFIGURED = False

MAX_BYTES = 5 * 1024 * 1024  # 5 Mo
BACKUP_COUNT = 5


def setup_logging() -> None:
    """Initialise les 3 handlers (app.log, errors.log, console) une seule
    fois — appelé au démarrage de main.py, sans effet si déjà appelé."""
    global _CONFIGURED
    if _CONFIGURED:
        return

    root = logging.getLogger("bacprep")
    root.setLevel(logging.INFO)
    root.propagate = False

    fmt = logging.Formatter(
        "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
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

    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    """Logger nommé `bacprep.<name>`, héritant des handlers configurés par
    `setup_logging`."""
    return logging.getLogger(f"bacprep.{name}")
