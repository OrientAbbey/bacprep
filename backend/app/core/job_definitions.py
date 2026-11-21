"""Constantes partagées entre le runner et la file de jobs.

Ce module est une feuille de dépendances : il n'importe ni ``job_runner`` ni
``job_queue``. Il casse le cycle d'imports qui obligeait le runner à importer
la file en différé à l'intérieur de ses fonctions.
"""
from __future__ import annotations

import os
import socket
import uuid

#: Identifiant unique du worker, utilisé pour la réclamation atomique des jobs.
WORKER_ID = os.getenv("JOB_WORKER_ID") or (
    f"{socket.gethostname()[:32]}:{os.getpid()}:{uuid.uuid4().hex[:6]}"
)

#: Cadence d'interrogation de la file (configurable, plancher 0,2 s).
POLL_S = max(0.2, float(os.getenv("JOB_WORKER_POLL_S", "2")))
