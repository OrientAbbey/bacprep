"""Vérification post-mise-à-jour : attend que le serveur réponde puis
exerce les endpoints de base (santé, config, SPA, catalogue, login mock,
session). Zéro dépendance hors stdlib — httpx n'est pas garanti ici."""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from urllib.parse import urlsplit

BASE = "http://127.0.0.1:8000"


def _url_locale(path: str) -> str:
    """Garde anti-SSRF : ce script de dev ne doit parler qu'au serveur
    local — tout autre hôte est refusé avant toute requête."""
    url = BASE + path
    host = (urlsplit(url).hostname or "").lower()
    if host not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError(f"Hôte non autorisé par ce script de dev : {host}")
    return url


def req(path: str, method: str = "GET", data: dict | None = None, cookie: str | None = None):
    r = urllib.request.Request(_url_locale(path), method=method)
    if cookie:
        r.add_header("Cookie", cookie)
    body = None
    if data is not None:
        r.add_header("Content-Type", "application/json")
        body = json.dumps(data).encode("utf-8")
    with urllib.request.urlopen(r, body, timeout=15) as resp:
        return resp.status, resp.headers, resp.read()


# 1. Attente du démarrage (uvicorn met 10-15 s à booter sur cette machine)
deadline = time.time() + 60
while True:
    try:
        status, _, _ = req("/api/health")
        if status == 200:
            break
    except Exception:
        if time.time() > deadline:
            print("ECHEC: serveur injoignable après 60 s")
            sys.exit(1)
        time.sleep(2)

checks: list[tuple[str, bool, str]] = []

# 2. Santé + config
status, headers, body = req("/api/health")
checks.append(("GET /api/health", status == 200, body.decode()))
checks.append(("header nosniff", headers.get("X-Content-Type-Options") == "nosniff", str(headers.get("X-Content-Type-Options"))))
checks.append(("header frame-deny", headers.get("X-Frame-Options") == "DENY", str(headers.get("X-Frame-Options"))))

status, _, body = req("/api/config")
checks.append(("GET /api/config", status == 200 and "max_historique" in body.decode(), body.decode()[:120]))

# 3. SPA servie (service unifié)
status, headers, body = req("/")
html = body.decode(errors="replace")
checks.append(("GET / (index.html)", status == 200 and "<div id=" in html, f"{len(body)} octets, type={headers.get('content-type')}"))

# 4. Catalogue public
status, _, body = req("/api/epreuves")
checks.append(("GET /api/epreuves", status == 200, body.decode()[:120]))

# 5. Login mock + session (cookie httpOnly renvoyé par le serveur)
import http.cookiejar

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None

opener = urllib.request.build_opener(NoRedirect)
login_req = urllib.request.Request(
    BASE + "/api/auth/mock-login",
    method="POST",
    data=json.dumps({"email": "verif@test.cm", "nom": "Vérification"}).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)
try:
    with opener.open(login_req, timeout=15) as resp:
        set_cookie = resp.headers.get("Set-Cookie", "")
        status = resp.status
except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
    status = e.code
    set_cookie = e.headers.get("Set-Cookie", "") if e.headers else ""
token = ""
for part in set_cookie.split(";"):
    if part.strip().startswith("bacprep_session="):
        token = part.strip().split("=", 1)[1]
checks.append(("POST /api/auth/mock-login", status == 200 and bool(token), f"status={status}, cookie={'oui' if token else 'non'}"))

if token:
    status, _, body = req("/api/auth/me", cookie=f"bacprep_session={token}")
    checks.append(("GET /api/auth/me (session)", status == 200 and "verif@test.cm" in body.decode(), body.decode()[:120]))

# 6. Un asset JS du build est servi
status, _, body = req("/assets/index-3rgKqMGq.js")
checks.append(("GET /assets/*.js (build)", status == 200 and len(body) > 100000, f"{len(body)} octets"))

print()
ok = True
for name, passed, detail in checks:
    print(("OK   " if passed else "ECHEC") + f"  {name}  ({detail})")
    ok = ok and passed
print()
print("VERIFICATION " + ("REUSSIE" if ok else "EN ECHEC"))
sys.exit(0 if ok else 2)
