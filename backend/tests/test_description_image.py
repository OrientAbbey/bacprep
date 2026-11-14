"""Description d'image (lot I / B2) : nettoyage du texte alternatif,
cascade Gemini → Groq vision et endpoint admin.

L'IA ne fait que PROPOSER un texte alternatif ; l'administrateur le relit
avant de l'enregistrer dans le Markdown. Aucune description simulée : si
aucun fournisseur ne répond, l'endpoint renvoie 503.
"""
from __future__ import annotations

import asyncio
import io
from pathlib import Path

import pytest


# --- Nettoyage du texte alternatif ---------------------------------------

def test_nettoyer_description_une_ligne_sans_crochets():
    from app.core import assistant

    texte = "Un triangle [ABC]\navec   un angle droit."
    assert assistant.nettoyer_description(texte) == "Un triangle (ABC) avec un angle droit."


def test_nettoyer_description_borne_et_ellipse():
    from app.core import assistant

    sortie = assistant.nettoyer_description("a" * (assistant.DESCRIPTION_MAX_CHARS + 50))
    assert len(sortie) == assistant.DESCRIPTION_MAX_CHARS
    assert sortie.endswith("…")


def test_nettoyer_description_vide():
    from app.core import assistant

    assert assistant.nettoyer_description("") == ""
    assert assistant.nettoyer_description(None) == ""


# --- Cascade : génération vs vision --------------------------------------

def test_call_cascade_generation_garde_groq_seul(monkeypatch):
    from app.core import assistant

    appels: list[tuple[str, list[str] | None]] = []

    async def fausse_gemini(prompt, image_paths):
        appels.append(("gemini", None))
        return "ne doit pas être appelé"

    async def faux_groq(prompt, image_paths, models=None):
        appels.append(("groq", models))
        return "réponse"

    monkeypatch.setattr(assistant, "_call_gemini", fausse_gemini)
    monkeypatch.setattr(assistant, "_call_groq", faux_groq)
    monkeypatch.setenv("GENERATION_GROQ_MODELS", "modele-fort,modele-leger")

    assert asyncio.run(assistant.call_cascade("génère", [])) == "réponse"
    assert appels == [("groq", ["modele-fort", "modele-leger"])]


def test_call_cascade_vision_essaie_gemini_puis_les_modeles_vision(monkeypatch):
    from app.core import assistant

    appels: list[tuple[str, list[str] | None]] = []

    async def fausse_gemini(prompt, image_paths):
        appels.append(("gemini", None))
        return None  # Gemini indisponible : repli Groq vision

    async def faux_groq(prompt, image_paths, models=None):
        appels.append(("groq", models))
        return "Une courbe."

    monkeypatch.setattr(assistant, "_call_gemini", fausse_gemini)
    monkeypatch.setattr(assistant, "_call_groq", faux_groq)
    monkeypatch.delenv("GROQ_VISION_MODELS", raising=False)

    assert asyncio.run(assistant.call_cascade("décris", [], vision_seulement=True)) == "Une courbe."
    assert appels[0][0] == "gemini"
    assert appels[1] == ("groq", sorted(assistant._GROQ_VISION_MODELS))


# --- decrire_image -------------------------------------------------------

def test_decrire_image_nettoie_et_borne(monkeypatch, tmp_path: Path):
    from app.core import assistant

    image = tmp_path / "figure.png"
    image.write_bytes(b"x")
    nettoyees: list[list[Path]] = []

    async def fausse_extraction(markdown, user_id=None):
        assert "/api/files/abc" in markdown
        assert user_id is None  # appel administrateur : pas de paywall
        return [image]

    async def fausse_cascade(prompt, image_paths, vision_seulement=False):
        assert vision_seulement is True
        assert "Mathématiques" in prompt
        return "ligne 1\n\nligne [2] " + "a" * (assistant.DESCRIPTION_MAX_CHARS + 10)

    monkeypatch.setattr(assistant, "_extract_local_image_paths_async", fausse_extraction)
    monkeypatch.setattr(assistant, "call_cascade", fausse_cascade)
    monkeypatch.setattr(assistant, "_cleanup_image_paths", lambda paths: nettoyees.append(paths))

    sortie = asyncio.run(assistant.decrire_image("abc", matiere="Mathématiques", lang="fr"))
    assert "\n" not in sortie
    assert "[" not in sortie and "]" not in sortie
    assert len(sortie) <= assistant.DESCRIPTION_MAX_CHARS
    assert sortie.endswith("…")
    assert nettoyees == [[image]]  # les images temporaires sont supprimées


def test_decrire_image_fichier_introuvable(monkeypatch):
    from app.core import assistant

    async def aucune_image(markdown, user_id=None):
        return []

    monkeypatch.setattr(assistant, "_extract_local_image_paths_async", aucune_image)
    with pytest.raises(FileNotFoundError):
        asyncio.run(assistant.decrire_image("absent"))


def test_decrire_image_aucun_fournisseur(monkeypatch, tmp_path: Path):
    from app.core import assistant

    image = tmp_path / "figure.png"
    image.write_bytes(b"x")

    async def fausse_extraction(markdown, user_id=None):
        return [image]

    async def aucune_reponse(prompt, image_paths, vision_seulement=False):
        return None

    monkeypatch.setattr(assistant, "_extract_local_image_paths_async", fausse_extraction)
    monkeypatch.setattr(assistant, "call_cascade", aucune_reponse)
    monkeypatch.setattr(assistant, "_cleanup_image_paths", lambda paths: None)

    with pytest.raises(assistant.FournisseursIndisponiblesError):
        asyncio.run(assistant.decrire_image("abc"))


# --- Endpoint admin ------------------------------------------------------

def _upload_png(admin, epreuve_id: str) -> dict:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (120, 80), (10, 20, 30)).save(buf, format="PNG")
    r = admin.post(
        f"/api/admin/epreuves/{epreuve_id}/images",
        files={"file": ("figure.png", buf.getvalue(), "image/png")},
        data={"cible": "sujet"},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_endpoint_description_propose_sans_ecrire(admin, epreuve_gratuite, monkeypatch):
    from app.core import assistant

    image = _upload_png(admin, epreuve_gratuite)
    appels: list[tuple[str, str, str]] = []

    async def fausse_description(file_id, matiere="", lang="fr"):
        appels.append((file_id, matiere, lang))
        return "Un triangle rectangle en A."

    monkeypatch.setattr(assistant, "decrire_image", fausse_description)
    r = admin.post(f"/api/admin/epreuves/{epreuve_gratuite}/images/{image['id']}/description")
    assert r.status_code == 200, r.text
    assert r.json() == {"description": "Un triangle rectangle en A."}
    assert appels == [(image["id"], "Mathématiques", "fr")]

    # Rien n'a été écrit dans le Markdown de l'épreuve.
    detail = admin.get(f"/api/admin/epreuves/{epreuve_gratuite}").json()
    assert "Un triangle rectangle" not in str(detail.get("sujets"))


def test_endpoint_description_image_inconnue_404(admin, epreuve_gratuite):
    r = admin.post(f"/api/admin/epreuves/{epreuve_gratuite}/images/inconnue/description")
    assert r.status_code == 404


def test_endpoint_description_image_dune_autre_epreuve_404(admin, epreuve_gratuite, epreuve_payante):
    image = _upload_png(admin, epreuve_gratuite)
    r = admin.post(f"/api/admin/epreuves/{epreuve_payante}/images/{image['id']}/description")
    assert r.status_code == 404


def test_endpoint_description_indisponible_503(admin, epreuve_gratuite, monkeypatch):
    from app.core import assistant

    image = _upload_png(admin, epreuve_gratuite)

    async def indisponible(file_id, matiere="", lang="fr"):
        raise assistant.FournisseursIndisponiblesError()

    monkeypatch.setattr(assistant, "decrire_image", indisponible)
    r = admin.post(f"/api/admin/epreuves/{epreuve_gratuite}/images/{image['id']}/description")
    assert r.status_code == 503
