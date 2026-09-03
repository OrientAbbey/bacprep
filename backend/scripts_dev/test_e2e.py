"""Test de bout en bout du service unifié (backend + SPA + API).

Parcours vérifié : SPA servie par FastAPI, navigation, catalogue public,
connexion élève, détail épreuve gratuit/payant, checkout scopé à la classe,
webhook, accès après paiement, URL signée d'image.
"""
import http.cookiejar
import json
import urllib.error
import urllib.request

B = "http://localhost:8000"


def req(method, path, body=None, headers=None, cookies=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(B + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    if cookies:
        r.add_header("Cookie", cookies)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


print("health:", req("GET", "/api/health"))
st, html = req("GET", "/")
print("SPA / :", st, len(html), "octets |", "Copies" in html)
st, html = req("GET", "/secondaire/terminale")
print("SPA /secondaire/terminale :", st, len(html), "octets (index.html servi)")

st, res = req("GET", "/api/epreuves/navigation")
nav = json.loads(res)
sec = next(n for n in nav["niveaux"] if n["code"] == "SECONDAIRE")
print("navigation SECONDAIRE:", [(c["code"], c["epreuves"], c["actif"]) for c in sec["classes"]])

st, res = req("GET", "/api/epreuves?classe=terminale")
public_list = json.loads(res)
print("catalogue public terminale:", [(e["matiere"], e["gratuit"]) for e in public_list])

st, res = req("GET", "/api/epreuves?q=math")
print("recherche globale 'math':", [(e["classe"], e["matiere"]) for e in json.loads(res)])

# --- parcours élève
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
data = json.dumps({"email": "eleve@demo.cm", "nom": "Demo"}).encode()
r = urllib.request.Request(B + "/api/auth/mock-login", data=data, method="POST")
r.add_header("Content-Type", "application/json")
op.open(r)
cookie = "; ".join(f"{c.name}={c.value}" for c in cj)

st, res = req("GET", "/api/epreuves?classe=terminale", cookies=cookie)
epreuves = json.loads(res)
free = next(e for e in epreuves if e["gratuit"])
paid = next((e for e in epreuves if not e["gratuit"]), None)

st, res = req("GET", f"/api/epreuves/{free['id']}", cookies=cookie)
det = json.loads(res)
print("detail gratuit:", st, "| sujet:", det["contenu_markdown"][:40].replace("\n", " "))

# S'il n'existe aucune épreuve payante (les 3 seedées sont gratuites :
# première épreuve de chaque série), en créer une via l'admin pour tester
# le parcours d'achat.
admin_created = False
if paid is None:
    st, res = req("POST", "/api/admin/login", {"email": "admin@example.com", "token": "admin123"})
    AT = {"X-Admin-Session": json.loads(res)["session_token"]}
    st, res = req(
        "POST",
        "/api/admin/epreuves",
        {
            "niveau": "SECONDAIRE",
            "classe": "terminale",
            "evaluation": "BAC",
            "matiere": "Philosophie",
            "annee": "2024",
            "filieres": ["A", "D"],
            "contenu_markdown": "# Dissertation de Philosophie\n\nSujet : la liberté.",
        },
        AT,
    )
    pid = json.loads(res)["id"]
    req("POST", f"/api/admin/epreuves/{pid}/publish", {}, AT)
    paid = {"id": pid}
    admin_created = True
    print("épreuve payante créée pour le test:", pid)

st, res = req("GET", f"/api/epreuves/{paid['id']}", cookies=cookie)
print("detail payant sans abonnement:", st, "(403 attendu)")

# checkout scopé classe + webhook → accès
st, res = req(
    "POST",
    "/api/subscriptions/checkout",
    {"scope": "epreuve", "epreuve_id": paid["id"]},
    cookies=cookie,
)
print("checkout epreuve:", st, json.loads(res).get("montant"))
ref = json.loads(res)["reference_agregateur"]
st, res = req("POST", "/api/payments/simulate-webhook", {"reference_agregateur": ref})
print("webhook:", st)

st, res = req("GET", f"/api/epreuves/{paid['id']}", cookies=cookie)
print("detail payant APRÈS paiement:", st, "(200 attendu)")

st, res = req("GET", "/api/subscriptions/mine", cookies=cookie)
subs = json.loads(res)
print("abonnements:", [(s["scope"], s["evaluation"], s["classe"], s["epreuves_couvertes"]) for s in subs])

if admin_created:
    st, res = req("POST", "/api/admin/login", {"email": "admin@example.com", "token": "admin123"})
    AT = {"X-Admin-Session": json.loads(res)["session_token"]}
    st, res = req("DELETE", f"/api/admin/epreuves/{paid['id']}", None, AT)
    print("nettoyage épreuve de test:", st)
