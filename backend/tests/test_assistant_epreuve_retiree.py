"""Régression du message frontend trompeur « Cette discussion n'existe plus
(elle a peut-être été fermée) ».

Cause (REVUE_BACKEND §1) : quand l'épreuve est RETIRÉE (repassée en
brouillon, `unpublish`) PENDANT une discussion persistée, la route assistant
levait un 404 « Épreuve introuvable » (→ le frontend l'étiquetait à tort
« Discussion fermée », alors que la discussion EXISTE toujours). Correctif :
`_load_conversation_and_epreuve` renvoie désormais un 403 EXPLICITE avec la
vraie raison (« retirée »), que le frontend affiche telle quelle (il
n'amalgame plus avec une discussion fermée)."""
from __future__ import annotations

import json


def _conversation(eleve, epreuve_gratuite: str) -> str:
    r = eleve.post(
        f"/api/epreuves/{epreuve_gratuite}/conversations",
        json={"contexte": "", "label": "Régression épreuve retirée"},
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _ask_stream(eleve, conv_id: str, message: str):
    """Appel streaming PERSISTÉ exactement comme le frontend ; renvoie la
    réponse brute (le 403 doit sortir en HTTP, avant tout flux SSE)."""
    return eleve.post(
        "/api/assistant/ask/stream",
        json={"conversation_id": conv_id, "message": message},
    )


def test_epreuve_retiree_resiste_en_403_et_non_404(eleve, epreuve_gratuite, admin):
    """REGRESSION : une épreuve repassée en brouillon pendant une discussion
    persistée doit répondre 403 avec la raison « retirée » (et non 404
    « Épreuve introuvable » qu'une URL de discussion laisse penser
    fermée)."""
    conv_id = _conversation(eleve, epreuve_gratuite)

    # Question valide TANT QUE l'épreuve est publique.
    r = _ask_stream(eleve, conv_id, "3+3 ?")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")
    done = [e for line in r.text.splitlines()
            if line.startswith("data:")
            for e in [json.loads(line[len("data:"):].strip())]
            if e["type"] == "done"]
    assert done, r.text

    # L'équipe retire l'épreuve → la MÊME discussion persistée doit échouer
    # en 403 « retirée », PAS en 404 (le frontend doit montrer la VRAIE
    # raison, jamais « discussion fermée »).
    r = admin.post(f"/api/admin/epreuves/{epreuve_gratuite}/unpublish")
    assert r.status_code == 200, r.text

    r = _ask_stream(eleve, conv_id, "Question après retrait ?")
    assert r.status_code == 403, f"{r.status_code} {r.text[:200]}"
    detail = r.json()["detail"].lower()
    assert "retir" in detail, detail


def test_get_conversation_sert_la_reconciliation(eleve, epreuve_gratuite, admin):
    """REGRESSION du message trompeur « Cette discussion n'existe plus » :
    avant l'ajout de cette route, le GET que la réconciliation frontend
    effectue avant CHAQUE tentative de streaming répondait 404 (« Ressource
    API introuvable »), que le frontend traduisait par « discussion
    fermée ». La discussion doit rester LISIBLE tant qu'elle existe (même
    si l'épreuve a été retirée — seule la route LLM lève alors le 403), et
    la réconciliation d'un convId inventé doit répondre 404."""
    conv_id = _conversation(eleve, epreuve_gratuite)
    url = f"/api/epreuves/{epreuve_gratuite}/conversations/{conv_id}"

    r = eleve.get(url)
    assert r.status_code == 200, r.text
    assert r.json()["id"] == conv_id

    # Retrait de l'épreuve : le GET reste 200 (la discussion existe toujours
    # et appartient à l'élève) — c'est l'INTERROGATION qui répond 403.
    r = admin.post(f"/api/admin/epreuves/{epreuve_gratuite}/unpublish")
    assert r.status_code == 200, r.text
    r = eleve.get(url)
    assert r.status_code == 200, r.text

    # Une discussion inexistante, elle, répond bien 404 (cas réel de
    # « discussion fermée »).
    r = eleve.get(f"/api/epreuves/{epreuve_gratuite}/conversations/aucun")
    assert r.status_code == 404, r.text

    # L'accès reste borné au propriétaire : un AUTRE élève ne voit pas la
    # discussion (404, pas de fuite).
    from fastapi.testclient import TestClient

    import app.main as app_main

    with TestClient(app_main.app) as autre:
        r = autre.post("/api/auth/mock-login", json={"email": "autre@test.cm", "nom": "Autre"})
        assert r.status_code == 200, r.text
        r = autre.get(url)
        assert r.status_code == 404, r.text
