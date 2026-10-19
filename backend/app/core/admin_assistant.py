"""Assistant IA du back-office : aide contextuelle à la rédaction des
épreuves (métadonnées + sujet + corrigé saisis dans le formulaire admin).

Conversations ÉPHÉMÈRES : rien n'est persisté côté serveur — le contexte
de chaque question est l'instantané du formulaire envoyé par le client, et
l'historique est borné et fourni par l'admin (aucune table, aucun état).

Réutilise l'infra LLM du module `assistant` (sémaphore de concurrence,
client httpx2 partagé, repli Gemini → Groq → mode démonstration) — seul le
prompt diffère : persona back-office, contraintes de format reprises des
règles `$…$`/`$$…$$` de l'assistant élève.
"""
from __future__ import annotations

from typing import AsyncIterator

from . import assistant as assistant_llm


def _contenu_epreuve(meta: dict, max_context_chars: int) -> str:
    """Markdown brut de TOUS les sujets/corrigés de l'éditeur (contenu non enregistré compris).

    Un seul sujet : format historique (`--- SUJET (Markdown brut) ---`, corrigé prioritaire en cas
    de troncature). Plusieurs : chaque partie est numérotée (`SUJET 2`, `CORRIGÉ 2`…) pour que
    l'assistant puisse cibler une modification (`remplacer-sujet:2`)."""
    sujets = [s for s in (meta.get("sujets") or []) if isinstance(s, dict)]
    if len(sujets) <= 1:
        unique = sujets[0] if sujets else meta
        sujet = (unique.get("contenu_markdown") or "").strip()
        corrige = (unique.get("corrige_markdown") or "").strip()
        contenu = f"--- CORRIGÉ (Markdown brut) ---\n{corrige}\n\n" if corrige else ""
        if sujet:
            candidate = f"{contenu}--- SUJET (Markdown brut) ---\n{sujet}"
            return candidate if len(candidate) <= max_context_chars else candidate[:max_context_chars]
        return contenu[:max_context_chars]
    parties = []
    for n, sj in enumerate(sujets, 1):
        sujet = (sj.get("contenu_markdown") or "").strip()
        corrige = (sj.get("corrige_markdown") or "").strip()
        parties.append(f"--- SUJET {n} (Markdown brut) ---\n{sujet or '(vide)'}")
        if corrige:
            parties.append(f"--- CORRIGÉ {n} (Markdown brut) ---\n{corrige}")
    contenu = "\n\n".join(parties)
    if len(contenu) > max_context_chars:
        contenu = contenu[:max_context_chars] + "\n[… contenu tronqué …]"
    return contenu


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
    niveau, classe, evaluation, matiere, annee, duree, coefficient,
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
    filieres = meta.get("filieres") or []
    statut = meta.get("statut") or "?"
    gratuit = meta.get("gratuit")

    contenu = _contenu_epreuve(meta, max_context_chars)

    lignes = [
        "Tu es l'assistant du back-office de BacPrep (Copies & Corrigés), un expert des "
        "épreuves du secondaire camerounais (6e → Terminale, Baccalauréat général et "
        "technique) : rédaction, relecture et conversion en Markdown.",
        "Tu aides un administrateur à rédiger, corriger ou améliorer le sujet et le corrigé "
        "d'une épreuve. Réponds de façon claire, précise et directement exploitable.",
        "Par défaut, tu préserves le style et la terminologie camerounais (GPC, théorème, "
        "barème en points…). Si le contenu de départ est incomplet ou manifestement faux, "
        "signale-le plutôt que de tout réécrire sans prévenir.",
        f"Épreuve en cours d'édition — {matiere} · {evaluation} {annee}"
        + f" · classe {classe} · séries {', '.join(filieres) if filieres else '?'}",
        f"Statut : {statut}" + (". Épreuve gratuite (consultation sans abonnement)." if gratuit else ". Épreuve payante."),
        # Cible par défaut des modifications quand l'admin dit « ce sujet » / ne précise pas de numéro.
        *([f"Sujet affiché dans l'éditeur : sujet {meta['sujet_actif']}."] if isinstance(meta.get("sujet_actif"), int) else []),
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
        "MODIFICATIONS APPLIQUÉES AUTOMATIQUEMENT : quand l'admin te demande de modifier, corriger, "
        "ajouter ou supprimer une partie du sujet ou du corrigé, tes modifications sont appliquées "
        "directement dans l'éditeur dès la fin de ta réponse (il peut les annuler). Utilise un bloc de "
        "code fencé dont le marqueur désigne la cible ; N est le numéro du sujet.",
        "1) MODIFICATION CIBLÉE (à privilégier, surtout sur un contenu long) : ```remplacer-sujet:N``` "
        "ou ```remplacer-corrige:N``` (sans :N = le sujet affiché dans l'éditeur) contenant une ou "
        "plusieurs paires de ce format exact :\n"
        "<<<<<<< CHERCHER\nextrait EXACT du contenu actuel\n=======\nnouveau texte\n>>>>>>> REMPLACER\n"
        "L'extrait CHERCHER doit exister MOT POUR MOT dans le contenu ci-dessus (espaces et retours à "
        "la ligne compris) et être assez long pour être unique : ne l'invente jamais, ne le résume "
        "pas. Pour AJOUTER à la fin, laisse la partie CHERCHER vide ; pour SUPPRIMER, laisse la partie "
        "REMPLACER vide.",
        "2) RÉÉCRITURE COMPLÈTE (seulement si l'admin demande de tout refaire, ou si le contenu est "
        "vide) : ```modification-sujet:N``` ou ```modification-corrige:N``` avec TOUT le Markdown "
        "révisé, jamais un extrait.",
        "Le texte que tu écris dans CHERCHER/REMPLACER est inséré tel quel : respecte le formatage du "
        "contenu (mêmes conventions de titres, listes et ancres `{#id}`, $$...$$ seuls sur leur ligne "
        "entourés de lignes vides, images ![..](/api/files/..) inchangées). Garde une explication "
        "brève AVANT le bloc et n'écris aucune autre version du contenu en dehors des blocs.",
        "MODIFICATIONS DU FORMULAIRE : si l'admin te demande de corriger les métadonnées ou "
        "les réglages de l'épreuve (matière, niveau, classe, évaluation, année, durée, "
        "coefficient, séries, statut ou gratuité), fournis le nouvel ensemble complet dans un "
        "bloc de code fencé ```modification-form``` contenant un objet JSON. Inclus TOUTES les "
        "clés que tu modifies — valeur doit être du bon type : `niveau` et `classe` en clair, "
        "`evaluation` une évaluation valide, `annee` en `'AAAA'`, "
        "`duree` en minutes (nombre), `coefficient` en nombre, `filieres` un tableau de codes "
        "de séries, `gratuit` un booléen, `statut` parmi `brouillon`, `a_reviser`, `publie`. "
        "Un seul bloc par réponse ; n'écris aucun autre contenu relevant du formulaire en "
        "dehors du bloc.",
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
    epreuve: dict, question: str, historique: list[dict], prompt: str | None = None
) -> AsyncIterator[str]:
    """Flux de réponse de l'assistant admin : Gemini → Groq → mode démo.

    Même mécanique que `assistant.ask_assistant_stream`, sans images
    (le contexte est du Markdown brut saisi dans l'éditeur, pas un passage
    sélectionné) et sans paywall : l'admin a accès à tout."""
    # `prompt` fourni : onglet hors édition d'épreuve (voir core/admin_tools.prompt_onglet).
    prompt = prompt or build_admin_prompt(epreuve, question, historique)
    async with assistant_llm._get_semaphore():
        got_any = False
        async for chunk in assistant_llm._stream_gemini(prompt, []):
            got_any = True
            yield chunk
        if got_any:
            return

        async for chunk in assistant_llm._stream_groq(prompt, []):
            got_any = True
            yield chunk
        if got_any:
            return

    if assistant_llm._est_prod():
        # Même règle que l'assistant élève : jamais de réponse SIMULÉE en
        # production (l'admin verrait une réponse factice pour une vraie
        # question). Le routeur la traduit en évènement SSE error.
        raise assistant_llm.FournisseursIndisponiblesError()
    yield _demo_fallback_admin(epreuve, question)