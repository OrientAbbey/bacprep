"""Erreurs applicatives typées et leur traduction HTTP.

Une erreur métier porte un ``code`` stable et un statut par défaut. Les
routeurs peuvent continuer à lever ``HTTPException`` quand le besoin est
ponctuel ; ce module fournit la voie structurée pour les nouveaux cas d'usage
et centralise la forme des réponses d'erreur.
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .logging_config import get_logger

log = get_logger("errors")


class AppError(Exception):
    """Erreur applicative : code stable, statut HTTP et détails optionnels."""

    code: str = "erreur"
    statut: int = 400

    def __init__(self, message: str, *, details: dict[str, Any] | None = None, statut: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}
        if statut is not None:
            self.statut = statut


def installer_handlers(app: FastAPI) -> None:
    """Enregistre le handler JSON pour ``AppError`` sur l'application."""

    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:  # noqa: ARG001
        log.warning("Erreur applicative %s: %s", exc.code, exc.message)
        return JSONResponse(
            status_code=exc.statut,
            content={"detail": exc.message, "code": exc.code, "details": exc.details},
        )
