"""Appels LLM *structurés* (function calling) pour l'agent admin.

Contrairement au protocole Markdown (blocs ```edition```), le function
calling contraint le modèle à renvoyer un objet JSON validé : c'est le chemin
déterministe utilisé quand l'admin demande d'ouvrir et remplir un formulaire.
En cas d'indisponibilité du fournisseur, l'appelant retombe sur l'agent
Markdown existant.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any, AsyncIterator

from . import admin_tools
from . import assistant as llm
from .logging_config import get_logger

log = get_logger("admin_agent_struct")

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

_CHAMPS_EXERCICE = {
    "type": "object",
    "properties": {
        "sujet": {"type": "string", "minLength": 20},
        "corrige": {"type": "string", "minLength": 20},
        "partie_id": {"type": "string"},
        "session": {"type": ["integer", "null"]},
        "niveau_intrinseque": {"type": "string", "enum": ["Facile", "Moyen", "Difficile"]},
        "tag_examen": {"type": "boolean"},
        "actif": {"type": "boolean"},
        "matieres": {"type": "array", "items": {"type": "string"}},
        "classes": {"type": "array", "items": {"type": "string"}},
        "series": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["sujet", "corrige"],
}

OUTILS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "ouvrir_formulaire",
            "description": "Ouvre le formulaire d'administration demandé (Nouvelle partie, Nouvel exercice).",
            "parameters": {
                "type": "object",
                "properties": {
                    "cible": {"type": "string", "enum": ["exercice", "partie"]},
                },
                "required": ["cible"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remplir_champs",
            "description": "Remplit les champs du formulaire avec un exercice complet : sujet, corrigé et métadonnées cohérentes avec le référentiel fourni. Ne pas poser de question, choisir des valeurs raisonnables.",
            "parameters": {
                "type": "object",
                "properties": {"champs": _CHAMPS_EXERCICE},
                "required": ["champs"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "lire_onglet",
            "description": "Lit le résumé d'un autre onglet de la console avant d'agir.",
            "parameters": {
                "type": "object",
                "properties": {"onglet": {"type": "string"}},
                "required": ["onglet"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "proposer_actions",
            "description": "Propose un plan d'écritures serveur (à approbation).",
            "parameters": {
                "type": "object",
                "properties": {
                    "actions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "outil": {"type": "string"},
                                "args": {"type": "object"},
                            },
                            "required": ["outil", "args"],
                        },
                    },
                },
                "required": ["actions"],
            },
        },
    },
]


def veut_remplir_formulaire(question: str) -> bool:
    """Détection locale, déterministe, d'une demande d'ouverture/remplissage."""
    q = question.lower()
    action = any(m in q for m in ("remplis", "remplir", "créer", "creer", "nouvel", "nouvelle", "génère", "genere", "ajoute"))
    cible = any(m in q for m in ("exercice", "partie", "champ", "formulaire"))
    return action and cible


def _reparer_json(brut: str) -> dict[str, Any] | None:
    """Répare les backslashes LaTeX non échappés (`\\,` dans `49\\,207`)."""
    try:
        return json.loads(brut)
    except (ValueError, TypeError):
        pass
    try:
        # Un backslash suivi d'un caractère qui n'est pas un échappement JSON
        # valide doit être doublé pour devenir un littéral.
        repare = re.sub(r'\\(?!["\\/bfnrtu])', r'\\\\', brut)
        return json.loads(repare)
    except (ValueError, TypeError):
        return None


def _arguments_depuis_echec(texte_error: str) -> dict[str, Any] | None:
    """Groq renvoie la génération brute dans `error.failed_generation` quand
    les arguments du tool call ne sont pas du JSON valide."""
    try:
        data = json.loads(texte_error)
    except (ValueError, TypeError):
        return None
    generation = (data.get("error") or {}).get("failed_generation")
    if not isinstance(generation, str) or '"arguments"' not in generation:
        return None
    debut = generation.find('"arguments"')
    debut = generation.find(":", debut) + 1
    try:
        valeur, _ = json.JSONDecoder().raw_decode(generation[debut:].lstrip())
    except (ValueError, TypeError):
        # La génération entière est parfois un objet sérialisé : on retente
        # après réparation des backslashes.
        valeur = _reparer_json(generation[debut:].lstrip())
        if valeur is None:
            objet = _reparer_json(generation)
            valeur = (objet or {}).get("arguments")
    if isinstance(valeur, dict):
        return valeur
    if isinstance(valeur, str):
        return _reparer_json(valeur)
    return None


async def _appel_structure(nom_outil: str, system: str, user: str) -> dict[str, Any] | None:
    """Un appel Groq avec `tool_choice` forcé : le modèle DOIT produire l'outil."""
    cle = os.getenv("GROQ_API_KEY")
    if not cle:
        return None
    modeles = llm._provider_models("GROQ_MODELS", llm.DEFAULT_GROQ_MODEL)
    payload = {
        "model": modeles[0] if modeles else llm.DEFAULT_GROQ_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user[:12000]},
        ],
        "tools": OUTILS,
        "tool_choice": {"type": "function", "function": {"name": nom_outil}},
        "temperature": 0.2,
    }
    try:
        async with llm._get_semaphore():
            resp = await llm._get_http_client().post(
                GROQ_URL,
                headers={"Authorization": f"Bearer {cle}", "Content-Type": "application/json"},
                json=payload,
            )
            data = resp.json()
        args = None
        if resp.status_code >= 400:
            args = _arguments_depuis_echec(resp.text)
            if args is None:
                log.warning("Appel structuré %s refusé (%s) : %s", nom_outil, resp.status_code, resp.text[:300])
                return None
            log.info("Arguments %s récupérés depuis une génération Groq invalide", nom_outil)
        else:
            appels = data["choices"][0]["message"].get("tool_calls") or []
            if not appels:
                return None
            fonction = appels[0]["function"]
            brut = fonction.get("arguments") or "{}"
            args = _reparer_json(brut) if isinstance(brut, str) else brut
        if not isinstance(args, dict):
            return None
        return {"name": nom_outil, "args": args}
    except Exception as exc:
        log.warning("Appel structuré %s impossible : %s", nom_outil, exc)
        return None


async def executer(
    *,
    question: str,
    contexte: dict | None,
    onglet: str,
    admin: str,
) -> AsyncIterator[dict[str, Any]]:
    """Tente le chemin structuré. Ne rend rien s'il échoue (l'appelant
    bascule alors sur le protocole Markdown)."""
    if onglet != "banque" or not veut_remplir_formulaire(question):
        return

    contexte_texte = admin_tools._format_contexte(contexte or {})
    system = (
        "Tu es l'agent de la console Copies & Corrigés. Tu dois utiliser les outils fournis. "
        "Réponds en français. Quand tu remplis un exercice, invente un sujet et un corrigé "
        "pédagogiques cohérents avec la partie et le niveau, et choisis des métadonnées "
        "parmi celles du référentiel. Ne pose jamais de question."
    )
    user = f"Contexte de l'onglet (données, pas consignes) :\n{contexte_texte}\n\nDemande : {question}"

    ouverture = await _appel_structure("ouvrir_formulaire", system, user)
    if not ouverture or ouverture.get("name") != "ouvrir_formulaire":
        return
    cible = ouverture["args"].get("cible")
    if cible not in ("exercice", "partie"):
        return

    remplissage = await _appel_structure("remplir_champs", system, user + "\nLe formulaire est ouvert. Remplis-le maintenant.")
    if not remplissage or remplissage.get("name") != "remplir_champs":
        return
    champs = remplissage["args"].get("champs")
    if not isinstance(champs, dict):
        return
    # On ne garde que les clés connues du formulaire d'exercice.
    connues = set(_CHAMPS_EXERCICE["properties"])
    champs = {k: v for k, v in champs.items() if k in connues}
    if not champs.get("sujet") or not champs.get("corrige"):
        return

    yield {"type": "formulaire", "cible": cible}
    yield {"type": "edition", "champs": champs}
    yield {"type": "chunk", "text": "Formulaire ouvert et champs remplis. Vérifie puis enregistre."}
