"""Atelier d'exercices : barème, contrôles automatiques, enchaînement des étapes (faux réseau, aucun appel réel) et route SSE.

Ce que ces tests ne disent PAS : la QUALITÉ pédagogique de ce qu'un vrai modèle écrit, ni son respect réel du format de barème demandé — le faux modèle ici est docile ; seuls les contrôles du serveur sont éprouvés.

Adapté depuis `evolution`. Différences de `refonte` : pas de cascade Cloudflare/OpenRouter (Groq seulement, deux modèles par essai), pas de journal de jetons, pas de traduction serveur par Accept-Language.
"""
from __future__ import annotations

import asyncio
import json
from fractions import Fraction

import httpx
import pytest

from app.core import assistant
from app.core import generation_exercices as gen

META = {"matiere": "Mathématiques", "classe": "terminale", "evaluation": "BAC", "filieres": ["C", "D"]}


# --- Barème ----------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("n", [1, 2, 3, 4, 5, 6, 7])
def test_repartition_exacte_par_quarts(n):
    parts = gen.repartir_points(Fraction(15), n)
    assert sum(parts) == 15 and len(parts) == n
    assert all(p % Fraction(1, 4) == 0 and p > 0 for p in parts)
    assert max(parts) - min(parts) <= Fraction(1, 4)  # répartition équilibrée


def test_repartition_valeurs_connues():
    assert gen.repartir_points(Fraction(15), 4) == [Fraction(15, 4)] * 4
    assert gen.repartir_points(Fraction(15), 3) == [Fraction(5)] * 3
    assert [gen.formater_points(p) for p in gen.repartir_points(Fraction(15), 4)] == ["3,75"] * 4


def test_formater_points():
    assert [gen.formater_points(Fraction(x)) for x in ("5", "0.5", "0.25", "7.5", "1")] == ["5", "0,5", "0,25", "7,5", "1"]


def test_somme_points_ignore_les_titres_et_accepte_les_variantes():
    md = "### Exercice 1 (99 points)\n1. a (0,5 pt)\n2. b (1 pt)\n3. c (0.25 pts)\n4. d (1,25 points)\n## PARTIE B (5 points)\n"
    assert gen.somme_points(md) == Fraction(3)


# --- Contrôles --------------------------------------------------------------------------------------------------------------

def _sujet_parfait(nb: int = 3) -> str:
    pts = gen.repartir_points(Fraction(15), nb)
    exos = [f"### Exercice {k} ({gen.formater_points(p)} points)\n\n1. Calculer $x$. ({gen.formater_points(p)} pt)" for k, p in enumerate(pts, 1)]
    return gen.assembler_sujet(exos, "### Situation\n\nTexte.\n\n1. Conclure. (5 pt)")


def _codes(controles):
    return {c["code"] for c in controles}


def test_sujet_parfait_sans_controle():
    assert gen.controles_sujet(_sujet_parfait(), 3) == []


def test_bareme_exercice_faux():
    s = _sujet_parfait().replace("1. Calculer $x$. (5 pt)", "1. Calculer $x$. (4,5 pt)", 1)
    ctl = gen.controles_sujet(s, 3)
    assert {"bareme_exercice", "bareme_partie", "bareme_total"} <= _codes(ctl)
    exo = next(c for c in ctl if c["code"] == "bareme_exercice")
    assert exo["params"] == {"k": 1, "attendu": "5", "trouve": "4,5"} and exo["niveau"] == "erreur"


def test_partie_b_mal_notee_ou_absente():
    s = _sujet_parfait().replace("(5 pt)", "(4 pt)")
    assert ("bareme_partie", "B") in {(c["code"], c["params"].get("partie")) for c in gen.controles_sujet(s, 3)}
    sans_b = _sujet_parfait().split("## PARTIE B")[0]
    assert "partie_b_absente" in _codes(gen.controles_sujet(sans_b, 3))


def test_exercice_manquant():
    s = _sujet_parfait(2)
    ctl = gen.controles_sujet(s, 3)
    assert next(c for c in ctl if c["code"] == "exercices_manquants")["params"]["manquants"] == [3]


def test_url_formule_et_doublon():
    s = _sujet_parfait() + "\nVoir https://exemple.cm\n"
    assert "url_externe" in _codes(gen.controles_sujet(s, 3))
    assert "delimiteur_formule" in _codes(gen.controles_sujet(_sujet_parfait() + "\nSoit $x + 1\n", 3))
    assert "delimiteur_formule" in _codes(gen.controles_sujet(_sujet_parfait() + "\n$$ x = 1\n", 3))
    q = "2. Déterminer la limite de la fonction en plus l'infini (0,5 pt)"
    assert "question_dupliquee" in _codes(gen.controles_sujet(_sujet_parfait() + f"\n{q}\n{q}\n", 3))


def test_controles_corrige():
    ok = "### Exercice 1\nx\n### Exercice 2\ny\n### Exercice 3\nz\n"
    assert gen.controles_corrige(ok, 3) == []
    ctl = gen.controles_corrige("### Exercice 1\nx\n⚠ PROBLÈME : la question 2 n'a pas de solution.\n", 3)
    assert {"corrige_exercices_manquants", "probleme_signale"} <= _codes(ctl)
    p = next(c for c in ctl if c["code"] == "probleme_signale")
    assert p["params"]["n"] == 1 and "pas de solution" in p["params"]["exemples"][0]


def test_a_des_erreurs():
    assert gen.a_des_erreurs([{"niveau": "erreur", "code": "x", "params": {}}])
    assert not gen.a_des_erreurs([{"niveau": "avertissement", "code": "x", "params": {}}])


# --- Plan et nettoyage ------------------------------------------------------------------------------------------------------

def test_lire_plan_valide_et_cloture():
    plan = '{"exercices": [{"titre": "Suites", "notions": "u_n"}, {"titre": "Limites", "notions": "lim"}], "situation": {"theme": "épargne"}}'
    assert gen.lire_plan(plan, 2, "t")["exercices"][1]["titre"] == "Limites"
    assert gen.lire_plan("```json\n" + plan + "\n```", 2, "t")["situation"]["theme"] == "épargne"
    assert gen.lire_plan("Voici : " + plan + " Bonne chance.", 2, "t")["situation"]["theme"] == "épargne"


@pytest.mark.parametrize("brut", ["pas du json", '{"exercices": []}', '{"exercices": [{"titre": "a", "notions": "b"}], "situation": {"theme": "s"}}', "{"])
def test_plan_invalide_remplace_par_un_plan_de_secours(brut):
    plan = gen.lire_plan(brut, 3, "Les suites")
    assert len(plan["exercices"]) == 3 and plan["situation"]["theme"] == "Les suites"


def test_titres_du_modele_remplaces_par_ceux_du_serveur():
    corps = gen._corps_exercice(2, Fraction(5), "### Exercice 9 (99 points)\n\nTexte")
    assert corps.startswith("### Exercice 2 (5 points)") and "Exercice 9" not in corps and "99" not in corps


# --- Enchaînement des étapes (faux réseau) ----------------------------------------------------------------------------------

class Faux:
    """Faux fournisseur compatible OpenAI qui répond selon l'étiquette « ### ÉTAPE : … » du prompt."""

    def __init__(self, monkeypatch, *, nb=3, exercice_faux=None, situation_fausse=False, plan="valide", pannes=0, probleme=False):
        self.nb, self.exercice_faux, self.situation_fausse, self.plan, self.pannes, self.probleme = nb, exercice_faux or {}, situation_fausse, plan, pannes, probleme
        self.appels: list[tuple[str, str]] = []  # (étape, modèle)
        self.essais_exercice: dict[int, int] = {}
        client = httpx.AsyncClient(transport=httpx.MockTransport(self.handler))
        monkeypatch.setattr(assistant, "_get_http_client", lambda: client)
        monkeypatch.setenv("GROQ_API_KEY", "k")
        monkeypatch.setenv("GENERATION_PAUSE_REESSAI", "0")

    def reponse(self, prompt: str) -> str:
        etape = prompt.split("\n", 1)[0]
        if "plan" in etape:
            if self.plan == "invalide":
                return "désolé, pas de JSON"
            exos = ", ".join(f'{{"titre": "Titre {k}", "notions": "notion {k}"}}' for k in range(1, self.nb + 1))
            return f'{{"exercices": [{exos}], "situation": {{"theme": "marché de Douala"}}}}'
        m = __import__("re").search(r"EXERCICE (\d+)", prompt)
        if "exercice" in etape and m:
            k = int(m.group(1))
            self.essais_exercice[k] = self.essais_exercice.get(k, 0) + 1
            pts = __import__("re").search(r"Total de l'exercice : ([\d,]+) points", prompt).group(1)
            faux = self.exercice_faux.get(k, 0)
            if self.essais_exercice[k] <= faux:  # le premier (ou les premiers) essais se trompent d'un quart de point
                return f"Énoncé {k}.\n\n1. Question A. (0,25 pt)\n2. Question B. ({pts} pt)"
            return f"### Exercice {k} (99 points)\n\nÉnoncé de l'exercice {k}, unique {k}.\n\n1. Question unique numéro {k}. ({pts} pt)"
        if "situation" in etape:
            return "Situation à Douala.\n\n1. Conclure. (4 pt)" if self.situation_fausse else "Situation à Douala.\n\n1. Conclure. (5 pt)"
        if "corrigé" in etape:
            ex = "".join(f"### Exercice {k}\nRéponse {k}.\n" for k in range(1, self.nb + 1))
            pb = "⚠ PROBLÈME : la donnée du marché est manquante.\n" if self.probleme else ""
            return f"## PARTIE A\n{ex}## PARTIE B\n### Situation\nRéponse.\n{pb}"
        return "?"

    def handler(self, request: httpx.Request) -> httpx.Response:
        corps = json.loads(request.content.decode())
        prompt = corps["messages"][0]["content"]
        self.appels.append((prompt.split("\n", 1)[0], corps["model"]))
        if self.pannes > 0:
            self.pannes -= 1
            return httpx.Response(500, json={"error": "panne"})
        return httpx.Response(200, json={"choices": [{"message": {"content": self.reponse(prompt)}}]})


def _generer(nb=3, theme="Les suites numériques", consignes=""):
    async def _tout():
        return [e async for e in gen.generer(META, theme, consignes, nb)]

    return asyncio.run(_tout())


def test_generation_nominale(monkeypatch):
    faux = Faux(monkeypatch)
    evts = _generer()
    assert [(e["code"], e.get("k")) for e in evts if e["type"] == "etape"] == [("plan", None), ("exercice", 1), ("exercice", 2), ("exercice", 3), ("situation", None), ("corrige", None)]
    assert all(e["total"] == 6 for e in evts if e["type"] == "etape")
    res = evts[-1]
    assert res["type"] == "resultat" and res["controles"] == []
    assert gen.somme_points(res["sujet"]) == 20
    assert res["sujet"].index("## PARTIE A") < res["sujet"].index("### Exercice 1 (5 points)") < res["sujet"].index("## PARTIE B")
    assert "99" not in res["sujet"]  # le titre « (99 points) » du modèle est remplacé par celui du serveur
    assert "### Exercice 3" in res["corrige"]
    assert {m for _, m in faux.appels} == {"openai/gpt-oss-120b"}  # modèle fort, imposé pour la génération


def test_modeles_de_generation_ne_changent_pas_ceux_du_tuteur(monkeypatch):
    Faux(monkeypatch)
    monkeypatch.setenv("GENERATION_GROQ_MODELS", "modele/fort")
    _generer(nb=1)
    assert assistant._provider_models("GROQ_MODELS", assistant.DEFAULT_GROQ_MODEL) == [assistant.DEFAULT_GROQ_MODEL]


def test_modeles_de_generation_reglables(monkeypatch):
    faux = Faux(monkeypatch)
    monkeypatch.setenv("GENERATION_GROQ_MODELS", "modele/a,modele/b")
    _generer(nb=1)
    assert {m for _, m in faux.appels} == {"modele/a"}


def test_reparation_d_un_exercice_au_bareme_faux(monkeypatch):
    faux = Faux(monkeypatch, exercice_faux={2: 1})
    evts = _generer()
    assert [e for e in evts if e["type"] == "etape" and e["code"] == "reparation"] == [{"type": "etape", "code": "reparation", "n": 5, "total": 6, "k": 2}]
    assert faux.essais_exercice == {1: 1, 2: 2, 3: 1}
    assert evts[-1]["controles"] == []


def test_reparation_insuffisante_laisse_l_erreur_visible(monkeypatch):
    Faux(monkeypatch, exercice_faux={2: 5})  # se trompe aussi au second essai
    res = _generer()[-1]
    erreurs = [c for c in res["controles"] if c["code"] == "bareme_exercice"]
    assert [c["params"]["k"] for c in erreurs] == [2]
    assert {"bareme_partie", "bareme_total"} <= _codes(res["controles"])


def test_reparation_de_la_situation(monkeypatch):
    faux = Faux(monkeypatch, situation_fausse=True)
    evts = _generer()
    rep = [e for e in evts if e["type"] == "etape" and e["code"] == "reparation"]
    assert len(rep) == 1 and "k" not in rep[0]
    assert sum(1 for etape, _ in faux.appels if "situation" in etape) == 2


def test_plan_invalide_la_generation_continue(monkeypatch):
    Faux(monkeypatch, plan="invalide")
    res = _generer()[-1]
    assert res["type"] == "resultat" and res["controles"] == []


def test_une_panne_passagere_est_reessayee(monkeypatch):
    faux = Faux(monkeypatch, pannes=2)  # les 2 modèles Groq en panne : le 1er essai échoue, le 2e réussit
    evts = _generer(nb=1)
    assert evts[-1]["type"] == "resultat"
    assert any("plan" in etape for etape, _ in faux.appels)


def test_panne_durable_erreur_franche_avec_l_etape(monkeypatch):
    Faux(monkeypatch, pannes=10**6)
    evts = _generer()
    assert evts[-1] == {"type": "erreur", "code": "indisponible", "etape": 1}
    assert not any(e["type"] == "resultat" for e in evts)


def test_probleme_signale_par_la_resolution(monkeypatch):
    Faux(monkeypatch, probleme=True)
    res = _generer()[-1]
    assert "probleme_signale" in _codes(res["controles"])


# --- Route -----------------------------------------------------------------------------------------------------------------

URL = "/api/admin/generation-exercices"
CORPS = {"theme": "Les suites numériques", "nb_exercices": 2, "meta": META}


def _flux(client, payload: dict) -> list[dict]:
    r = client.post(URL, json=payload)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")
    return [json.loads(line[len("data:"):].strip()) for line in r.text.splitlines() if line.startswith("data:")]


def test_route_reservee_aux_administrateurs(visiteur, eleve):
    assert visiteur.post(URL, json=CORPS).status_code == 401
    assert eleve.post(URL, json=CORPS).status_code == 401


@pytest.mark.parametrize("modif", [{"theme": "ab"}, {"nb_exercices": 0}, {"nb_exercices": 6}, {"consignes": "x" * 501}])
def test_route_valide_les_entrees(admin, monkeypatch, modif):
    Faux(monkeypatch)
    assert admin.post(URL, json={**CORPS, **modif}).status_code == 422


def test_route_sans_fournisseur_503(admin, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    r = admin.post(URL, json=CORPS)
    assert r.status_code == 503
    assert "indisponible" in r.json()["detail"]


def test_route_refuse_une_epreuve_publiee(admin, epreuve_gratuite, monkeypatch):
    Faux(monkeypatch)
    r = admin.post(URL, json={**CORPS, "epreuve_id": epreuve_gratuite})
    assert r.status_code == 409
    assert "déjà publiée" in r.json()["detail"]


def test_route_flux_complet_et_audit(admin, db, monkeypatch):
    from app.db_models import AdminEventORM

    Faux(monkeypatch, nb=2)
    evts = _flux(admin, CORPS)
    assert [e["type"] for e in evts] == ["etape"] * 5 + ["resultat"]
    assert evts[-1]["controles"] == []
    ev = db.query(AdminEventORM).filter(AdminEventORM.action == "generation_exercices").one()
    assert json.loads(ev.details) == {"theme": "Les suites numériques", "nb_exercices": 2, "erreurs": 0}
    assert "Réponse" not in ev.details and "Question" not in ev.details  # le texte généré n'est jamais journalisé


def test_route_n_enregistre_rien_dans_les_epreuves(admin, db, monkeypatch):
    from app.db_models import EpreuveORM

    Faux(monkeypatch, nb=1)
    avant = db.query(EpreuveORM).count()
    _flux(admin, {**CORPS, "nb_exercices": 1})
    assert db.query(EpreuveORM).count() == avant


def test_route_limite_de_debit(admin, monkeypatch):
    from app.routers import admin_generation

    Faux(monkeypatch, nb=1)
    monkeypatch.setenv("ASSISTANT_RATE_LIMIT", "1")
    admin_generation._gen_limiter._attempts.clear()
    codes = [admin.post(URL, json={**CORPS, "nb_exercices": 1}).status_code for _ in range(7)]
    admin_generation._gen_limiter._attempts.clear()
    assert codes[:6] == [200] * 6 and codes[6] == 429
