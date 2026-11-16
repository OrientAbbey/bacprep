"""Vérification de la console Admin sur un déploiement (Render / staging).

Le script ne partage aucun secret : il les lit dans l'environnement de la
machine où il est exécuté. Par défaut il ne fait QUE des lectures. L'option
``--write`` lance un export de test et vérifie le suivi jusqu'au rapport ;
``--cleanup`` supprime ensuite la sauvegarde créée.

Prérequis : Python 3.10+ (stdlib uniquement), accès réseau à l'URL.

    VERIFY_URL=https://mon-service.onrender.com \
    VERIFY_ADMIN_TOKEN=... \
    VERIFY_ADMIN_EMAIL=admin@example.com \
    python backend/scripts_dev/verifier_prod_admin.py

    # avec export de test et nettoyage :
    ... python backend/scripts_dev/verifier_prod_admin.py --write --cleanup

    # reprendre le suivi d'un job déjà lancé (sans en créer un autre) :
    ... python backend/scripts_dev/verifier_prod_admin.py --job-id <id> --cleanup
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
from http.cookies import SimpleCookie
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class Verif:
    def __init__(self, base: str, timeout: float):
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )
        self.ok = 0
        self.echecs = 0
        # Le frontend envoie le jeton brut dans `X-Admin-Session` ; le cookie
        # httpOnly peut être perdu selon les redirections/le proxy. On capture
        # sa valeur au login et on la rejoue explicitement ensuite.
        self.session_token: str | None = None
        self.login_body: dict[str, object] = {}

    def _requete(self, method: str, chemin: str, corps: object = None) -> tuple[int, object]:
        donnees = None
        en_tetes = {"Accept": "application/json"}
        if corps is not None:
            donnees = json.dumps(corps).encode("utf-8")
            en_tetes["Content-Type"] = "application/json"
        if self.session_token:
            en_tetes["X-Admin-Session"] = self.session_token
        req = urllib.request.Request(
            f"{self.base}{chemin}", data=donnees, headers=en_tetes, method=method
        )
        try:
            with self.opener.open(req, timeout=self.timeout) as reponse:
                for brut in reponse.headers.get_all("Set-Cookie", []):
                    cookie = SimpleCookie()
                    cookie.load(brut)
                    if "admin_session" in cookie:
                        self.session_token = cookie["admin_session"].value
                return reponse.status, json.loads(reponse.read().decode("utf-8") or "null")
        except urllib.error.HTTPError as err:
            texte = err.read().decode("utf-8", errors="replace")
            try:
                return err.code, json.loads(texte)
            except json.JSONDecodeError:
                return err.code, {"detail": texte[:500]}

    def appeler(self, method: str, chemin: str, corps: object = None) -> tuple[int, object]:
        code, donnees = self._requete(method, chemin, corps)
        if code == 401 and chemin != "/api/admin/login" and self.session_token:
            print("       session admin expirée — reconnexion...")
            self._relogin()
            code, donnees = self._requete(method, chemin, corps)
        return code, donnees

    def _relogin(self) -> None:
        code, _ = self._requete("POST", "/api/admin/login", self.login_body)
        if code != 200:
            print(f"       reconnexion impossible (HTTP {code})")

    def verifier(self, nom: str, condition: bool, detail: str = "") -> bool:
        if condition:
            self.ok += 1
            print(f"  OK   {nom}")
            return True
        self.echecs += 1
        print(f"  FAIL {nom}" + (f" — {detail}" if detail else ""))
        return False

    def lancer(self, ecrire: bool, nettoyer: bool, job_id_existant: str | None = None) -> None:
        print(f"Vérification de {self.base}")
        token = os.getenv("VERIFY_ADMIN_TOKEN", "")
        email = os.getenv("VERIFY_ADMIN_EMAIL", "")
        force = os.getenv("VERIFY_FORCE", "").strip().lower() in {"1", "true", "oui"}
        if not token:
            self.verifier("VERIFY_ADMIN_TOKEN défini", False)
            return

        corps_login: dict[str, object] = {"token": token, "force": force}
        if email:
            corps_login["email"] = email
        self.login_body = corps_login
        code, data = self.appeler("POST", "/api/admin/login", corps_login)
        if code == 409 and not force:
            self.verifier(
                "connexion admin",
                False,
                "un autre admin détient le verrou — relancer avec VERIFY_FORCE=true",
            )
            return
        self.verifier("connexion admin (200)", code == 200, f"HTTP {code} {data}")
        if code != 200:
            return

        code, stats = self.appeler("GET", "/api/admin/stats")
        self.verifier("statistiques admin (200)", code == 200, f"HTTP {code}")

        code, inventaire = self.appeler("GET", "/api/admin/sauvegardes")
        valide = (
            code == 200
            and isinstance(inventaire, dict)
            and isinstance(inventaire.get("sauvegardes"), list)
            and isinstance(inventaire.get("ignorees"), list)
        )
        self.verifier("inventaire lisible (200, listes présentes)", valide, f"HTTP {code}")
        if valide:
            print(f"       {len(inventaire['sauvegardes'])} sauvegarde(s), "
                  f"{len(inventaire['ignorees'])} ignorée(s)")

        code, jobs_sauvegarde = self.appeler("GET", "/api/admin/sauvegardes/jobs")
        self.verifier(
            "liste des jobs de sauvegarde (200)",
            code == 200 and isinstance(jobs_sauvegarde, dict)
            and isinstance(jobs_sauvegarde.get("jobs"), list),
            f"HTTP {code}",
        )

        code, jobs_import = self.appeler("GET", "/api/admin/import/jobs")
        self.verifier(
            "liste des imports (200)",
            code == 200 and isinstance(jobs_import, list),
            f"HTTP {code}",
        )

        code, snapshot = self.appeler("GET", "/api/admin/banque/export")
        self.verifier(
            "export banque (200, schemaVersion 1.0)",
            code == 200 and isinstance(snapshot, dict) and snapshot.get("schemaVersion") == "1.0",
            f"HTTP {code}",
        )

        if job_id_existant:
            self._verifier_export(nettoyer, job_id_existant)
        elif ecrire:
            self._verifier_export(nettoyer)

    def _verifier_export(self, nettoyer: bool, job_id_existant: str | None = None) -> None:
        if job_id_existant:
            job_id = job_id_existant
            print(f"  — reprise du job existant {job_id} —")
        else:
            print("  — export de test (écriture) —")
            code, job = self.appeler("POST", "/api/admin/sauvegardes/export", {})
            if not self.verifier("lancement export (200)", code == 200, f"HTTP {code} {job}"):
                return
            job_id = job.get("id") if isinstance(job, dict) else None
            if not job_id:
                self.verifier("identifiant de job renvoyé", False, str(job))
                return
            print(f"       job de test : {job_id}")

        echeance = time.time() + self.timeout
        etat: dict = {}
        derniere_trace = 0.0
        while time.time() < echeance:
            code, etat = self.appeler("GET", f"/api/admin/sauvegardes/jobs/{job_id}")
            if code != 200:
                self.verifier("lecture du job", False, f"HTTP {code}")
                return
            if etat.get("status") in {"done", "error"}:
                break
            maintenant = time.time()
            if maintenant - derniere_trace >= 15:
                print(
                    f"       statut={etat.get('status')} phase={etat.get('phase') or '-'} "
                    f"durée={etat.get('duration_ms')} heartbeat={etat.get('heartbeat_at') or '-'}"
                )
                derniere_trace = maintenant
            time.sleep(2)
        self.verifier(
            "job terminé",
            etat.get("status") == "done",
            f"statut={etat.get('status')} après {self.timeout:.0f}s"
            + (f" — reprendre avec --job-id {job_id}" if etat.get("status") != "done" else ""),
        )
        if etat.get("status") != "done":
            return
        self.verifier("durée serveur renseignée", etat.get("duration_ms") is not None)
        self.verifier(
            "rapport avec parties", bool((etat.get("report") or {}).get("parties"))
        )

        cle = etat.get("destination", "")
        print(f"       sauvegarde de test : {cle}")
        code, inventaire = self.appeler("GET", "/api/admin/sauvegardes")
        self.verifier(
            "sauvegarde visible dans l'inventaire",
            code == 200 and any(s.get("cle") == cle for s in inventaire.get("sauvegardes", [])),
            f"clé={cle}",
        )
        if nettoyer and cle:
            code, _ = self.appeler(
                "DELETE", f"/api/admin/sauvegardes/{urllib.parse.quote(cle, safe='/')}"
            )
            self.verifier("nettoyage de la sauvegarde de test", code == 200, f"HTTP {code}")
        elif cle:
            print(f"       sauvegarde de test à supprimer manuellement : {cle}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="lance un export de test")
    parser.add_argument("--cleanup", action="store_true", help="supprime la sauvegarde créée")
    parser.add_argument(
        "--job-id",
        help="reprend le suivi d'un job existant au lieu d'en créer un nouveau",
    )
    parser.add_argument(
        "--timeout", type=float, default=None,
        help="délai max en secondes pour le polling (défaut : VERIFY_TIMEOUT ou 600)",
    )
    args = parser.parse_args()
    timeout = args.timeout if args.timeout is not None else float(os.getenv("VERIFY_TIMEOUT", "600"))

    base = os.getenv("VERIFY_URL", "").strip()
    if not base:
        print("VERIFY_URL est obligatoire (URL du service Render / staging).", file=sys.stderr)
        return 2

    verif = Verif(base, timeout)
    verif.lancer(args.write, args.cleanup, args.job_id)
    print(f"\n{verif.ok} OK, {verif.echecs} échec(s)")
    return 0 if verif.echecs == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
