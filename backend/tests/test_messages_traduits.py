"""Contrat de traduction : un message du serveur qu'un élève peut voir doit avoir sa traduction dans `en.json`.

Le front affiche ces textes avec `t(message)` : sans clé, l'élève anglophone lit du français. Un nouveau message
d'erreur non traduit fait donc échouer ce test ; s'il ne peut jamais s'afficher à l'écran d'un élève (configuration,
appel d'API direct), on l'ajoute à `TECHNIQUES` avec la raison."""

import ast
import json
from pathlib import Path

RACINE = Path(__file__).resolve().parents[2]
APP = RACINE / "backend" / "app"
EN = json.loads((RACINE / "frontend" / "src" / "locales" / "en.json").read_text(encoding="utf-8"))

# Routeurs que l'interface élève appelle (la console admin reste volontairement en français).
ROUTEURS_ELEVE = ["auth", "me", "epreuves", "assistant", "subscriptions", "essais", "files", "notifications", "calendrier", "avatar", "ws", "deps"]

# Messages produits hors `HTTPException`/`message=` : évènement d'erreur du flux, session fermée, IA indisponible.
HORS_ROUTEURS = [
    "Une erreur est survenue côté serveur.",
    "Votre session a été fermée car vous vous êtes connecté ailleurs.",
    "Ton compte a été suspendu par l'équipe — contacte-nous si tu penses que c'est une erreur.",
    "Les fournisseurs d'IA sont temporairement indisponibles — réessaie dans quelques minutes.",
]

_CONFIG = "configuration du serveur : n'apparaît jamais dans l'interface élève"
_WEBHOOK = "appelé par l'opérateur de paiement, pas par l'interface"
_VALIDATION = "champ toujours envoyé par l'interface : n'apparaît qu'en cas d'appel direct de l'API"
TECHNIQUES: dict[str, str] = {
    "Connexion simulée désactivée (AUTH_MODE != mock)": _CONFIG,
    "GOOGLE_CLIENT_ID non configuré côté serveur": _CONFIG,
    "Webhook de paiement non configuré": _CONFIG,
    "Webhook de paiement non configuré (PAYMENT_WEBHOOK_SECRET absent)": _CONFIG,
    "Montant incohérent avec le paiement enregistré": _WEBHOOK,
    "Notification trop ancienne (timestamp invalide ou rejoué)": _WEBHOOK,
    "Signature de webhook invalide": _WEBHOOK,
    "Session admin invalide ou expirée": "console admin, volontairement en français",
    "annee requise": _VALIDATION,
    "filiere requise": _VALIDATION,
    "matiere et annee requises": _VALIDATION,
    "matiere requise": _VALIDATION,
    "scope inconnu": _VALIDATION,
    "epreuve_id requis pour ce type d'abonnement": _VALIDATION,
    "epreuve_id requis pour une question éphémère": _VALIDATION,
}


def _litteraux(chemin: Path) -> set[str]:
    return {n.value for n in ast.walk(ast.parse(chemin.read_text(encoding="utf-8"))) if isinstance(n, ast.Constant) and isinstance(n.value, str)}


def _messages(chemin: Path) -> set[str]:
    trouves = set()
    for n in ast.walk(ast.parse(chemin.read_text(encoding="utf-8"))):
        if not isinstance(n, ast.Call):
            continue
        nom = getattr(n.func, "id", getattr(n.func, "attr", ""))
        candidats = (n.args[1:2] + [k.value for k in n.keywords if k.arg == "detail"]) if nom == "HTTPException" else [k.value for k in n.keywords if k.arg == "message"]
        trouves |= {c.value for c in candidats if isinstance(c, ast.Constant) and isinstance(c.value, str)}
    return trouves


def test_messages_serveur_eleve_traduits():
    messages = set()
    for nom in ROUTEURS_ELEVE:
        messages |= _messages(APP / "routers" / f"{nom}.py")
    for chemin in (APP / "core").glob("*.py"):
        messages |= _messages(chemin)
    manquants = sorted(m for m in messages - set(TECHNIQUES) if m not in EN)
    assert not manquants, "messages serveur sans traduction dans frontend/src/locales/en.json :\n" + "\n".join(manquants)


def test_messages_hors_routeurs_existent_et_traduits():
    tous = set().union(*(_litteraux(p) for p in APP.rglob("*.py")))
    for m in HORS_ROUTEURS:
        assert m in tous, f"message introuvable dans le backend (reformulé ?) : {m}"
        assert m in EN, f"sans traduction : {m}"


def test_exceptions_techniques_justifiees_et_encore_utiles():
    messages = set()
    for nom in ROUTEURS_ELEVE:
        messages |= _messages(APP / "routers" / f"{nom}.py")
    for chemin in (APP / "core").glob("*.py"):
        messages |= _messages(chemin)
    assert all(TECHNIQUES.values()), "chaque exception doit dire pourquoi"
    assert not [m for m in TECHNIQUES if m not in messages], "exception devenue inutile : à retirer"


def test_gabarits_d_activite_et_valeurs_traduisibles_traduits():
    """La timeline du profil envoie un gabarit (`cle`) et ses `params` ; le front fait `t(cle, params)`, en
    traduisant aussi les valeurs de `params` qui sont des mots du produit (portée, statut d'abonnement)."""
    from app.core.subscriptions import SCOPE_LABELS

    gabarits = set()
    for n in ast.walk(ast.parse((APP / "routers" / "me.py").read_text(encoding="utf-8"))):
        if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "_activite_item" and len(n.args) >= 3:
            gabarits |= {c.value for c in ast.walk(n.args[2]) if isinstance(c, ast.Constant) and isinstance(c.value, str)}
    assert len(gabarits) >= 8, "gabarits introuvables : le contrôle ne vérifie plus rien"
    valeurs = set(SCOPE_LABELS.values()) | {"active", "annulee"}
    assert not sorted(m for m in gabarits | valeurs if m not in EN), "sans traduction dans en.json"
