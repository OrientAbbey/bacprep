"""Tâches planifiées déclenchées de l'extérieur (GitHub Actions) : Render gratuit
n'a pas de cron. Protégées par le jeton `CRON_TOKEN` (en-tête `X-Cron-Token`)."""
from __future__ import annotations

import os
import secrets
from types import SimpleNamespace

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from ..core.rate_limit import SlidingWindowLimiter
from ..db import get_db
from . import admin_sauvegardes

router = APIRouter(prefix="/api/cron", tags=["cron"])

# Un jeton volé ne doit pas pouvoir enchaîner des exports : 3 par heure, tous appelants confondus.
_limiteur = SlidingWindowLimiter(
    max_attempts=3, window_seconds=3600.0, message="Trop d'exports demandés — réessaie plus tard", env_switch="LOGIN_RATE_LIMIT"
)


def _verifier(jeton: str) -> None:
    attendu = os.getenv("CRON_TOKEN", "").strip()
    if len(attendu) < 24:  # absent ou trop court : la route reste fermée
        raise HTTPException(503, "Tâches planifiées non configurées")
    if not secrets.compare_digest(jeton.encode(), attendu.encode()):
        raise HTTPException(401, "Jeton invalide")


@router.post("/backup")
def sauvegarde_planifiee(
    background: BackgroundTasks, x_cron_token: str = Header(default=""), db: Session = Depends(get_db)
) -> dict:
    """Lance l'export habituel (même code, même destination — le stockage
    objet configuré — que l'onglet Sauvegardes) ; tracé au journal sous l'acteur « cron »."""
    _verifier(x_cron_token)
    _limiteur.check("cron")
    job = admin_sauvegardes.lancer_export(background, admin_sauvegardes.SauvegardeExportDemande(), db=db, lock=SimpleNamespace(email="cron"))
    return {"ok": True, "job_id": job.get("id")}
