from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import os
import re
import tempfile
from pathlib import Path
from typing import AsyncIterator, Optional

import httpx

from .epreuve_files import file_id_from_url
from .logging_config import get_logger
from .storage import get_storage

log = get_logger("assistant")

DEFAULT_GEMINI_MODEL = "gemini-3.5-flash"
DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b"

MAX_CONTEXT_CHARS = 4000
MAX_IMAGES_PAR_QUESTION = 3

# --- Modèles par fournisseur (fallback ordonné) --------------------------
#
# Chaque fournisseur essaie sa liste de modèles DANS L'ORDRE déclaré
# (GEMINI_MODELS / GROQ_MODELS, CSV) : en cas d'échec du premier — quota
# 429, indisponibilité, erreur — on passe au suivant avant de basculer sur
# l'autre fournisseur puis le mode démonstration. La variable simple
# historique (GEMINI_MODEL / GROQ_MODEL) reste acceptée comme repli si la
# liste n'est pas définie.


def _provider_models(plural_env: str, single_env: str, default: str) -> list[str]:
    """Modèles (fallback ordonné) d'un fournisseur : GEMINI_MODELS /
    GROQ_MODELS (CSV, ordre = ordre d'essai), repli sur la variable simple
    héritée puis sur le défaut du module."""
    raw = os.getenv(plural_env, "").strip() or os.getenv(single_env, "").strip()
    models = [m.strip() for m in raw.split(",") if m.strip()]
    return models or [default]

# --- Streaming ---------------------------------------------------------
#
# Le streaming est ACTIVÉ PAR DÉFAUT pour tout fournisseur qui le supporte.
# Gemini (`:streamGenerateContent?alt=sse`) et Groq (API compatible OpenAI,
# `stream: true`) le supportent tous les deux pour l'ensemble de leur
# catalogue de modèles de chat — ce n'est pas une capacité limitée à
# certains modèles précis chez ces deux fournisseurs, contrairement à ce
# qu'on pourrait devoir vérifier ailleurs (ex. certains modèles "batch
# only"). Cette table sert de point d'extension si un modèle spécifique
# s'avérait ne PAS le supporter :
#
# IMPORTANT — limite connue : cette liste n'a pas pu être vérifiée en
# direct contre la page officielle des limites de débit de Groq
# (https://console.groq.com/docs/rate-limits) au moment de l'écriture de
# ce code, l'environnement de génération n'ayant pas d'accès réseau
# sortant. Le comportement par défaut (`True` pour tout modèle non
# explicitement listé ici) reflète la documentation générale de l'API
# compatible OpenAI de Groq. Revérifie cette page avant la mise en
# production si un modèle Groq non-standard est configuré.
STREAMING_UNSUPPORTED_MODELS: set[str] = set()


def _model_supports_streaming(model: str) -> bool:
    """Vrai sauf si le modèle figure explicitement dans
    STREAMING_UNSUPPORTED_MODELS (voir l'avertissement ci-dessus)."""
    return model not in STREAMING_UNSUPPORTED_MODELS


_semaphore: Optional[asyncio.Semaphore] = None

# Client httpx partagé (connexions réutilisées entre appels LLM ; un
# AsyncClient par appel relançait une poignée TLS à chaque question).
# timeout=60 couvre les appels streaming les plus longs.
_shared_client: Optional[httpx.AsyncClient] = None

_IMAGE_MD_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)\)")


def _get_http_client() -> httpx.AsyncClient:
    global _shared_client
    if _shared_client is None or _shared_client.is_closed:
        _shared_client = httpx.AsyncClient(timeout=60)
    return _shared_client


def _get_semaphore() -> asyncio.Semaphore:
    """Sémaphore partagé bornant le nombre d'appels LLM concurrents
    (`LLM_CONCURRENCY_LIMIT`, défaut 5) — au-delà, les appels attendent
    leur tour plutôt que de risquer de heurter les limites de débit des
    offres gratuites (voir CAHIER_DES_CHARGES, section 10.2)."""
    global _semaphore
    if _semaphore is None:
        limit = int(os.getenv("LLM_CONCURRENCY_LIMIT", "5"))
        _semaphore = asyncio.Semaphore(limit)
    return _semaphore


def _extract_local_image_paths(markdown: str, user_id: str | None = None) -> list[Path]:
    """Retrouve les images `![légende](/api/files/...)` référencées dans un
    passage Markdown (typiquement le contexte transmis par le lecteur, qui
    peut inclure une image sélectionnée par l'élève — voir
    CAHIER_DES_CHARGES, Module 5) et les récupère depuis le stockage objet
    (dossier temporaire local) pour les transmettre en pièce jointe à un
    fournisseur LLM multimodal (Gemini). Les URL signées (?token=...) sont
    acceptées : le jeton n'est qu'un accélérateur, l'accès backend aux
    fichiers est direct.

    Paywall : chaque image est servie SEULEMENT si l'utilisateur a accès à
    l'épreuve qui la porte (`store.has_access`). Le contexte des
    discussions étant rédigé par le client, un abonné pourrait sinon y
    glisser les ids de fichiers d'une épreuve payante et faire décrire ces
    images par le modèle — un contournement du paywall.

    FONCTION BLOQUANTE (I/O stockage + disque) : NE JAMAIS l'appeler
    directement depuis une coroutine — passer par
    `_extract_local_image_paths_async`."""
    storage_dir = Path(os.getenv("TEMP", tempfile.gettempdir())) / "bacprep_assistant_images"
    storage_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for url in _IMAGE_MD_RE.findall(markdown or ""):
        file_id = file_id_from_url(url)
        if not file_id:
            continue
        try:
            row = _fetch_image_row(file_id, user_id)
        except Exception as exc:
            log.warning("Image %s introuvable en base: %s", file_id, exc)
            continue
        if row is None:
            continue
        try:
            data = get_storage().get_bytes(row.storage_key)
        except Exception as exc:
            log.warning("Lecture stockage impossible pour %s: %s", row.storage_key, exc)
            continue
        ext = mimetypes.guess_extension(row.mime_type) or ".png"
        path = storage_dir / f"{file_id}{ext}"
        try:
            path.write_bytes(data)
        except OSError as exc:
            log.warning("Écriture image temporaire impossible (%s): %s", path, exc)
            continue
        paths.append(path)
        if len(paths) >= MAX_IMAGES_PAR_QUESTION:
            break
    return paths


async def _extract_local_image_paths_async(markdown: str, user_id: str | None = None) -> list[Path]:
    """Variante async : déporte le travail bloquant sur un thread pour ne
    pas geler la boucle d'événements pendant chaque question posée."""
    return await asyncio.to_thread(_extract_local_image_paths, markdown, user_id)


def _cleanup_image_paths(paths: list[Path]) -> None:
    """Supprime les images temporaires extraites pour une question —
    sinon le dossier %TEMP%/bacprep_assistant_images grossissait à chaque
    échange (fuite disque lente mais réelle)."""
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def _fetch_image_row(file_id: str, user_id: str | None = None):
    """Ligne `epreuve_files` d'une image (session DB dédiée, courte durée —
    cette fonction est appelée pendant une requête SSE de longue vie).

    Renvoie None si l'utilisateur n'a pas accès à l'épreuve porteuse
    (paywall) — le contexte étant fourni par le client, on ne fait
    confiance à aucun `/api/files/{id}` qui y apparaît."""
    from ..db import SessionLocal
    from ..db_models import EpreuveFileORM, EpreuveORM
    from . import store

    db = SessionLocal()
    try:
        row = (
            db.query(EpreuveFileORM)
            .filter(
                EpreuveFileORM.id == file_id,
                EpreuveFileORM.format == "image",
            )
            .one_or_none()
        )
        if row is None:
            return None
        if user_id is not None:
            epreuve = db.query(EpreuveORM).filter(EpreuveORM.id == row.epreuve_id).one_or_none()
            if epreuve is None or not store.has_access(db, user_id, epreuve):
                log.warning(
                    "Image %s ignorée : utilisateur %s sans accès à l'épreuve %s (paywall)",
                    file_id, user_id, row.epreuve_id,
                )
                return None
        db.expunge(row)
        return row
    finally:
        db.close()


def _build_prompt(epreuve_meta: dict, contexte: str, question: str, historique: list[dict]) -> str:
    """Construit le prompt texte envoyé au LLM : instructions de rôle et de
    format (Markdown strict), contexte Markdown brut (tronqué à
    MAX_CONTEXT_CHARS), puis les derniers échanges de la discussion.

    Note : `historique` reçu par les appelants inclut déjà le message
    "question" en cours (ajouté avant l'appel) — on l'exclut donc du tour
    d'historique pour ne pas le présenter deux fois au modèle (une fois
    via l'historique, une fois via la ligne finale explicite).
    """
    contexte = (contexte or "")[:MAX_CONTEXT_CHARS]
    lignes = [
        "Tu es un assistant pédagogique pour un élève camerounais de Terminale "
        "qui prépare le Baccalauréat.",
        f"Matière : {epreuve_meta.get('matiere', '?')} — Filières : "
        f"{', '.join(epreuve_meta.get('filieres', []) or [])} — Année : {epreuve_meta.get('annee', '?')}.",
        "Réponds de façon claire, pédagogique et concise, adaptée au niveau Terminale.",
        "Réponds STRICTEMENT en Markdown : utilise des formules LaTeX pour les "
        "expressions mathématiques, des tableaux Markdown si utile, et des listes "
        "à puces pour structurer une explication en étapes. N'utilise jamais de HTML brut.",
        "RÈGLE STRICTE pour les formules mathématiques : délimite-les UNIQUEMENT avec des "
        "signes dollar — $...$ pour une formule dans le texte, $$...$$ pour une formule "
        "isolée. N'utilise JAMAIS \\( \\), \\[ \\] comme délimiteurs (non supportés par le "
        "moteur de rendu). Un environnement comme \\begin{aligned}...\\end{aligned} doit "
        "toujours être placé à l'intérieur de $$...$$, jamais laissé nu. IMPORTANT : place "
        "toujours $$...$$ sur SA PROPRE LIGNE, entourée de lignes vides, jamais au milieu "
        "d'une phrase (ex. jamais \"donc $$x=1$$ car...\") — sinon la formule n'est pas "
        "reconnue et s'affiche en texte brut.",
        "",
        "Passage/contexte de l'épreuve concerné (Markdown brut, peut contenir des formules, "
        "des tableaux et des images) :",
        contexte or "(aucun passage précis sélectionné — l'épreuve entière sert de contexte général)",
        "",
    ]
    # Exclut le dernier message s'il s'agit déjà de la question posée
    # (cas standard : l'appelant l'a ajouté à `historique` avant d'appeler
    # cette fonction) pour éviter la duplication décrite ci-dessus.
    historique_precedent = historique
    if historique and historique[-1].get("role") == "user" and historique[-1].get("content") == question:
        historique_precedent = historique[:-1]

    for m in historique_precedent[-6:]:
        role = "Élève" if m.get("role") == "user" else "Assistant"
        lignes.append(f"{role} : {m.get('content', '')}")
    lignes.append(f"Élève : {question}")
    return "\n".join(lignes)


def _image_to_gemini_part(path: Path) -> Optional[dict]:
    """Encode une image locale en `inline_data` base64 pour l'API Gemini."""
    mime_type, _ = mimetypes.guess_type(path.name)
    if not mime_type or not mime_type.startswith("image/"):
        return None
    try:
        data = base64.b64encode(path.read_bytes()).decode("ascii")
    except Exception as exc:
        log.warning("Lecture de l'image %s impossible : %s", path, exc)
        return None
    return {"inline_data": {"mime_type": mime_type, "data": data}}


def _gemini_parts(prompt: str, image_paths: list[Path]) -> list[dict]:
    """Assemble les `parts` Gemini (texte + éventuelles images en pièce
    jointe) — factorisé entre les variantes streaming et non-streaming."""
    parts: list[dict] = [{"text": prompt}]
    for path in image_paths:
        part = _image_to_gemini_part(path)
        if part:
            parts.append(part)
    if len(parts) > 1:
        log.info("%d image(s) jointe(s) à la question (mode multimodal Gemini)", len(parts) - 1)
    return parts


async def _call_gemini(prompt: str, image_paths: list[Path]) -> Optional[str]:
    """Appel Gemini non-streaming (réponse complète en un seul bloc) —
    conservé pour le endpoint `/api/assistant/ask` historique et comme
    filet de secours si le streaming échoue avant le premier chunk.
    Essaie chaque modèle de `GEMINI_MODELS` (fallback ordonné) ; rend
    la main (None) pour basculer sur Groq si tous échouent."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return None
    client = _get_http_client()
    for model in _provider_models("GEMINI_MODELS", "GEMINI_MODEL", DEFAULT_GEMINI_MODEL):
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        try:
            resp = await client.post(
                url,
                headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
                json={"contents": [{"parts": _gemini_parts(prompt, image_paths)}]},
            )
            resp.raise_for_status()
            data = resp.json()
            return data["candidates"][0]["content"]["parts"][0]["text"]
        except httpx.HTTPStatusError as exc:
            log.warning("Gemini %s a échoué (%s) : %s", model, exc.response.status_code, exc.response.text)
        except Exception as exc:
            log.warning("Gemini %s a échoué (exception): %s", model, exc)
    return None


async def _stream_gemini(prompt: str, image_paths: list[Path]) -> AsyncIterator[str]:
    """Variante streaming de `_call_gemini` : consomme l'endpoint SSE
    `:streamGenerateContent?alt=sse` de Gemini et cède chaque fragment de
    texte au fur et à mesure de sa réception, plutôt que d'attendre la
    réponse complète. Essaie chaque modèle de `GEMINI_MODELS` dans l'ordre
    (fallback) tant qu'aucun fragment n'a été cédé.

    Ne cède RIEN (générateur vide) si aucune clé n'est configurée ou si
    tous les modèles échouent avant tout fragment — l'appelant
    (`ask_assistant_stream`) détecte ce cas et bascule sur Groq. Si
    l'échec survient APRÈS que des fragments ont déjà été envoyés au
    client, la réponse reste partielle (compromis assumé pour ce
    prototype : on ne peut plus revenir en arrière sur ce qui a déjà été
    affiché à l'écran)."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return
    client = _get_http_client()
    for model in _provider_models("GEMINI_MODELS", "GEMINI_MODEL", DEFAULT_GEMINI_MODEL):
        if not _model_supports_streaming(model):
            continue
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
        produced = False
        try:
            async with client.stream(
                "POST",
                url,
                headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
                json={"contents": [{"parts": _gemini_parts(prompt, image_paths)}]},
            ) as resp:
                if resp.status_code >= 400:
                    body = await resp.aread()
                    log.warning(
                        "Gemini %s (streaming) a échoué (%s) : %s",
                        model,
                        resp.status_code,
                        body.decode(errors="replace"),
                    )
                    continue
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[len("data:"):].strip()
                    if not raw:
                        continue
                    try:
                        data = json.loads(raw)
                        text = data["candidates"][0]["content"]["parts"][0]["text"]
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue
                    if text:
                        produced = True
                        yield text
                return  # modèle consommé jusqu'au bout : pas de repli nécessaire
        except Exception as exc:
            log.warning("Gemini %s (streaming) a échoué (exception): %s", model, exc)
            if produced:
                return  # réponse partielle déjà cédée : ne pas repartir sur un autre modèle
            continue  # rien cédé avant l'échec : essayer le modèle suivant


def _groq_prompt_with_image_note(prompt: str, nb_images_ignorees: int) -> str:
    """Préfixe le prompt d'une note si des images ont dû être ignorées
    (Groq est un modèle texte seul) — factorisé entre les variantes
    streaming et non-streaming."""
    if not nb_images_ignorees:
        return prompt
    # Groq (Llama 3.3 70B) est un modèle texte seul : on le signale
    # explicitement dans le prompt plutôt que de perdre silencieusement
    # l'information qu'une image faisait partie du contexte.
    return (
        f"[Note : {nb_images_ignorees} image(s) faisaient partie du passage sélectionné, "
        "mais ce fournisseur ne traite pas les images — réponds en te basant uniquement "
        "sur le texte.]\n\n" + prompt
    )


async def _call_groq(prompt: str, nb_images_ignorees: int) -> Optional[str]:
    """Appel Groq non-streaming — conservé pour `/api/assistant/ask` et
    comme filet de secours si le streaming échoue avant le premier chunk.
    Essaie chaque modèle de `GROQ_MODELS` (fallback ordonné)."""
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        return None
    client = _get_http_client()
    prompt = _groq_prompt_with_image_note(prompt, nb_images_ignorees)
    url = "https://api.groq.com/openai/v1/chat/completions"
    for model in _provider_models("GROQ_MODELS", "GROQ_MODEL", DEFAULT_GROQ_MODEL):
        try:
            resp = await client.post(
                url,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"model": model, "messages": [{"role": "user", "content": prompt}]},
            )
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"]
        except httpx.HTTPStatusError as exc:
            log.warning("Groq %s a échoué (%s) : %s", model, exc.response.status_code, exc.response.text)
        except Exception as exc:
            log.warning("Groq %s a échoué (exception): %s", model, exc)
    return None


async def _stream_groq(prompt: str, nb_images_ignorees: int) -> AsyncIterator[str]:
    """Variante streaming de `_call_groq`, via l'option `stream: true` de
    l'API compatible OpenAI de Groq (format SSE `data: {...}`, terminé par
    `data: [DONE]`) — supportée par l'ensemble du catalogue de modèles de
    chat Groq (voir l'avertissement sur `STREAMING_UNSUPPORTED_MODELS` en
    tête de ce module concernant la vérification de cette page). Essaie
    chaque modèle de `GROQ_MODELS` dans l'ordre (fallback) tant qu'aucun
    fragment n'a été cédé."""
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        return
    client = _get_http_client()
    prompt = _groq_prompt_with_image_note(prompt, nb_images_ignorees)
    url = "https://api.groq.com/openai/v1/chat/completions"
    for model in _provider_models("GROQ_MODELS", "GROQ_MODEL", DEFAULT_GROQ_MODEL):
        if not _model_supports_streaming(model):
            continue
        produced = False
        try:
            async with client.stream(
                "POST",
                url,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": True,
                },
            ) as resp:
                if resp.status_code >= 400:
                    body = await resp.aread()
                    log.warning(
                        "Groq %s (streaming) a échoué (%s) : %s",
                        model,
                        resp.status_code,
                        body.decode(errors="replace"),
                    )
                    continue
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[len("data:"):].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    try:
                        data = json.loads(raw)
                        delta = data["choices"][0]["delta"].get("content")
                    except (json.JSONDecodeError, KeyError, IndexError):
                        delta = None
                    if delta:
                        produced = True
                        yield delta
                return  # modèle consommé jusqu'au bout : pas de repli nécessaire
        except Exception as exc:
            log.warning("Groq %s (streaming) a échoué (exception): %s", model, exc)
            if produced:
                return  # réponse partielle déjà cédée : ne pas repartir sur un autre modèle
            continue  # rien cédé avant l'échec : essayer le modèle suivant


def _demo_fallback(epreuve_meta: dict, question: str, image_paths: list[Path]) -> str:
    """Réponse simulée renvoyée quand Gemini et Groq sont tous deux
    indisponibles (aucune clé configurée, ou échec des deux)."""
    note_image = f" (dont {len(image_paths)} image(s) jointe(s))" if image_paths else ""
    return (
        "**[Mode démonstration]** — aucune clé `GEMINI_API_KEY` ou `GROQ_API_KEY` valide "
        "n'est configurée, ou les deux fournisseurs ont échoué.\n\n"
        f"Voici une réponse simulée à ta question *« {question} »*{note_image} à propos de "
        f"**{epreuve_meta.get('matiere', 'cette épreuve')}**. Configure une vraie clé API dans "
        "le fichier `.env` du backend pour obtenir une réponse générée."
    )


async def ask_assistant(
    epreuve_meta: dict, contexte: str, question: str, historique: list[dict],
    user_id: str | None = None,
) -> str:
    """Réponse complète (non-streaming) : Gemini → Groq → mode démo. Utilisé
    par l'endpoint historique `/api/assistant/ask` ; l'endpoint par défaut
    côté frontend est désormais `/api/assistant/ask/stream` (voir
    `ask_assistant_stream` ci-dessous). `user_id` sert au contrôle du
    paywall sur les images référencées par le contexte."""
    prompt = _build_prompt(epreuve_meta, contexte, question, historique)
    image_paths = await _extract_local_image_paths_async(contexte, user_id)
    try:
        async with _get_semaphore():
            reponse = await _call_gemini(prompt, image_paths)
            if reponse:
                return reponse
            reponse = await _call_groq(prompt, nb_images_ignorees=len(image_paths))
            if reponse:
                return reponse

        log.info("Bascule vers le mode démonstration (Gemini et Groq indisponibles)")
        return _demo_fallback(epreuve_meta, question, image_paths)
    finally:
        _cleanup_image_paths(image_paths)


async def ask_assistant_stream(
    epreuve_meta: dict, contexte: str, question: str, historique: list[dict],
    user_id: str | None = None,
) -> AsyncIterator[str]:
    """Variante streaming de `ask_assistant`, activée par défaut côté
    frontend (`/api/assistant/ask/stream`) pour tout fournisseur qui la
    supporte. Cède le texte au fur et à mesure de sa génération plutôt que
    d'attendre la réponse complète — perçu comme nettement plus réactif,
    en particulier sur une connexion mobile lente (voir
    CAHIER_DES_CHARGES, persona élève avec connexion instable).

    Bascule Gemini → Groq → mode démo, comme la variante non-streaming :
    si Gemini ne cède AUCUN fragment (clé absente, échec avant le premier
    chunk), on retente entièrement sur Groq ; si Groq échoue aussi, on cède
    un unique fragment "mode démonstration" (pas de streaming réel dans ce
    cas puisqu'il n'y a rien à streamer). `user_id` sert au contrôle du
    paywall sur les images référencées par le contexte."""
    prompt = _build_prompt(epreuve_meta, contexte, question, historique)
    image_paths = await _extract_local_image_paths_async(contexte, user_id)
    try:
        async with _get_semaphore():
            got_any = False
            async for chunk in _stream_gemini(prompt, image_paths):
                got_any = True
                yield chunk
            if got_any:
                return

            async for chunk in _stream_groq(prompt, nb_images_ignorees=len(image_paths)):
                got_any = True
                yield chunk
            if got_any:
                return

        log.info("Bascule vers le mode démonstration (Gemini et Groq indisponibles, streaming)")
        yield _demo_fallback(epreuve_meta, question, image_paths)
    finally:
        _cleanup_image_paths(image_paths)
