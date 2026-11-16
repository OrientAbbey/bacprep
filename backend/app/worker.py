"""Processus worker autonome : ``python -m app.worker``.

Utile quand le service web ne doit pas exécuter les travaux longs (plan gratuit
où le processus web dort, conteneur séparé, ou simple isolation des ressources).
La file étant persistée en base, ce processus et le thread intégré sont
interchangeables : il suffit de mettre ``JOB_WORKER_ENABLED=0`` sur le service
web pour que lui seul consomme les jobs.

Arrêt propre : SIGINT (Ctrl+C) et SIGTERM terminent la boucle après le job en
cours, sans laisser la ligne ``running`` sans heartbeat — le recouvrement la
reprendra de toute façon au prochain démarrage.
"""
from __future__ import annotations

import signal
import sys
import threading

from .core.job_queue import boucle_worker
from .core.logging_config import get_logger
from .db import BASE_DIR

log = get_logger("worker")


def main() -> int:
    arret = threading.Event()

    def _arreter(signum, _frame) -> None:
        log.info("Signal %s reçu — arrêt demandé", signum)
        arret.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _arreter)
        except (ValueError, OSError):
            # Plateforme sans ce signal (ou appel depuis un thread) : la boucle
            # reste arrêtable par le terme du processus.
            pass

    log.info("Worker autonome — base=%s", BASE_DIR)
    boucle_worker(arret)
    return 0


if __name__ == "__main__":
    sys.exit(main())
