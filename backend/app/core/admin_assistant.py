"""Assistant IA du back-office : aide contextuelle à la rédaction des
épreuves (métadonnées + sujet + corrigé saisis dans le formulaire admin).

Conversations ÉPHÉMÈRES : rien n'est persisté côté serveur — le contexte
de chaque question est l'instantané du formulaire envoyé par le client, et
l'historique est borné et fourni par l'admin (aucune table, aucun état).

Réutilise l'infra LLM du module `assistant` (sémaphore de concurrence,
client httpx partagé, repli Gemini → Groq → mode démonstration) — seul le
prompt diffère : persona back-office, contraintes de format reprises des
règles `$…$`/`$$…$$` de l'assistant élève.
"""
from __future__ import annotations

from typing import AsyncIterator

from . import assistant as assistant_llm


def build_admin_prompt(
    epreuve: dict,
    question: str,
    historique: list[dict],
    max_context_chars: int = assistant_llm.MAX_CONTEXT_CHARS,
) -> str:
    """Construit le prompt texte envoyé au LLM : persona « assistant du
    back-office », contexte = métadonnées + Markdown brut sujet/corrigé
    (tronqués ensemble à `max_context_chars`), puis les derniers échanges
    et la question de l'admin.

    `epreuve` est l'instantané du formulaire (voir AdminAssistantPanel) :
    niveau, classe, evaluation, matiere, annee, session, duree, coefficient,
    gratuit, statut, filieres, contenu_markdown, corrige_markdown — les clés
    absentes sont tolérées (repli sur « ? »).

    `historique` reçu inclut DÉJÀ la question courante en dernier user
    message (ajout côté client) : on l'exclut du tour d'historique pour ne
    pas la présenter deux fois (même convention que `_build_prompt`)."""
    meta = epreuve or {}
    matiere = meta.get("matiere") or "?"
    classe = meta.get("classe") or "?"
    evaluation = meta.get("evaluation") or "?"
    annee = meta.get("annee") or "?"
    session = meta.get("session")
    filieres = meta.get("filieres") or []
    statut = meta.get("statut") or "?"
    gratuit = meta.get("gratuit")

    sujet = (meta.get("contenu_markdown") or "").strip()
    corrige = (meta.get("corrige_markdown") or "").strip()

    # Contexte partagé : sujet + corrigé, tronqués ENSEMBLE pour rester dans
    # le plafond de contexte (le corrigé est prioritaire si les deux ne
    # tiennent pas — c'est celui qui a le plus à gagner d'une relecture).
    contenu = ""
    if corrige:
        contenu = f"--- CORRIGÉ (Markdown brut) ---\n{corrige}\n\n"
    if sujet:
        candidate = f"{contenu}--- SUJET (Markdown brut) ---\n{sujet}"
        contenu = candidate if len(candidate) <= max_context_chars else candidate[:max_context_chars]
    else:
        contenu = contenu[:max_context_chars]

    lignes = [
        "Tu es l'assistant du back-office de BacPrep (Copies & Corrigés), un expert des "
        "épreuves du secondaire camerounais (6e → Terminale, Baccalauréat général et "
        "technique) : rédaction, relecture et conversion en Markdown.",
        "Tu aides un administrateur à rédiger, corriger ou améliorer le sujet et le corrigé "
        "d'une épreuve. Réponds de façon claire, précise et directement exploitable.",
        "Par défaut, tu préserves le style et la terminologie camerounais (GPC, théorème, "
        "barème en points…). Si le contenu de départ est incomplet ou manifestement faux, "
        "signale-le plutôt que de tout réécrire sans prévenir.",
        f"Épreuve en cours d'édition — {matiere} · {evaluation} {annee}" + (f" · {session}" if session else "")
        + f" · classe {classe} · séries {', '.join(filieres) if filieres else '?'}",
        f"Statut : {statut}" + (". Épreuve gratuite (consultation sans abonnement)." if gratuit else ". Épreuve payante."),
        "Réponds STRICTEMENT en Markdown : utilise des formules LaTeX pour les expressions "
        "mathématiques, des tableaux Markdown si utile, et des listes à puces pour structurer. "
        "N'utilise jamais de HTML brut.",
        "RÈGLE STRICTE pour les formules mathématiques : délimite-les UNIQUEMENT avec des "
        "signes dollar — $...$ pour une formule dans le texte, $$...$$ pour une formule "
        "isolée. N'utilise JAMAIS \\( \\), \\[ \\] comme délimiteurs (non supportés par le "
        "moteur de rendu). Un environnement comme \\begin{aligned}...\\end{aligned} doit "
        "toujours être placé à l'intérieur de $$...$$, jamais laissé nu. IMPORTANT : place "
        "toujours $$...$$ sur SA PROPRE LIGNE, entourée de lignes vides, jamais au milieu "
        "d'une phrase.",
        "Les images se référencent avec ![Légende](/api/files/{id}#w=300) (fragment #w=NNN "
        "pour la largeur d'affichage — absent = taille pleine). Les ancres `{#id}` servent "
        "aux renvois GPC/Théorique.",
        "MODIFICATIONS APPLICABLES : si l'admin te demande de MODIFIER ou RÉÉCRIRE le sujet "
        "ou le corrigé, fournis la version complète révisée dans un bloc de code fencé "
        "portant le marqueur spécial correspondant — ```modification-sujet``` pour le sujet, "
        "```modification-corrige``` pour le corrigé. Le bloc doit contenir TOUT le Markdown "
        "révisé (prêt à remplacer la zone de texte correspondante), JAMAIS un extrait ou un "
        "résumé des changements. Un seul bloc par cible ; garde une explication concise "
        "avant le bloc et n'écris aucune autre version du contenu en dehors de lui.",
        "",
        "Contenu brut de l'épreuve (sujet et corrigé tels que saisis dans l'éditeur) :",
        contenu or "(épreuve vide — aucune métadonnée de contenu fournie)",
        "",
    ]

    historique_precedent = historique
    if historique and historique[-1].get("role") == "user" and historique[-1].get("content") == question:
        historique_precedent = historique[:-1]
    for m in historique_precedent[-6:]:
        role = "Admin" if m.get("role") == "user" else "Assistant"
        lignes.append(f"{role} : {m.get('content', '')}")
    lignes.append(f"Admin : {question}")
    return "\n".join(lignes)


def _demo_fallback_admin(epreuve: dict, question: str) -> str:
    """Réponse simulée quand Gemini et Groq sont tous deux indisponibles
    (aucune clé configurée, ou échec des deux) — variante admin de
    `assistant._demo_fallback`."""
    matiere = (epreuve or {}).get("matiere") or "cette épreuve"
    return (
        "**[Mode démonstration]** — aucune clé `GEMINI_API_KEY` ou `GROQ_API_KEY` valide "
        "n'est configurée, ou les deux fournisseurs ont échoué.\n\n"
        f"Voici une réponse simulée à ta question *« {question} »* à propos de "
        f"**{matiere}**. Configure une vraie clé API dans le fichier `.env` du backend "
        "pour obtenir une réponse générée."
    )


async def ask_admin_assistant_stream(
    epreuve: dict, question: str, historique: list[dict]
) -> AsyncIterator[str]:
    """Flux de réponse de l'assistant admin : Gemini → Groq → mode démo.

    Même mécanique que `assistant.ask_assistant_stream`, sans images
    (le contexte est du Markdown brut saisi dans l'éditeur, pas un passage
    sélectionné) et sans paywall : l'admin a accès à tout."""
    prompt = build_admin_prompt(epreuve, question, historique)
    async with assistant_llm._get_semaphore():
        got_any = False
        async for chunk in assistant_llm._stream_gemini(prompt, []):
            got_any = True
            yield chunk
        if got_any:
            return

        async for chunk in assistant_llm._stream_groq(prompt, nb_images_ignorees=0):
            got_any = True
            yield chunk
        if got_any:
            return

    yield _demo_fallback_admin(epreuve, question)