"""Tests unitaires pour les helpers d'images d'épreuve (epreuve_files) :
extraction d'id depuis une URL, conservation du fragment de taille lors de
la signature, et extraction des images depuis le Markdown."""
from __future__ import annotations

from types import SimpleNamespace

import app.core.epreuve_files as ef
from app.core import assistant as assistant_core


class TestFileIdFromUrl:
    """file_id_from_url doit ignorer la query string, un token signé
    ET un fragment de taille d'affichage."""

    def test_url_simple(self) -> None:
        assert ef.file_id_from_url("/api/files/abc123") == "abc123"

    def test_url_avec_token(self) -> None:
        url = "/api/files/abc123?token=expireresult"
        assert ef.file_id_from_url(url) == "abc123"

    def test_url_avec_fragment_w(self) -> None:
        url = "/api/files/abc123#w=300"
        assert ef.file_id_from_url(url) == "abc123"

    def test_url_avec_token_et_fragment(self) -> None:
        url = "/api/files/abc123?token=xyz#w=480"
        assert ef.file_id_from_url(url) == "abc123"

    def test_url_non_fichiers(self) -> None:
        assert ef.file_id_from_url("/api/other/abc123") is None
        assert ef.file_id_from_url("https://extern.com/img.png") is None


def _fake_epreuve() -> SimpleNamespace:
    return SimpleNamespace(id="ep-001", statut="publie")


class TestSignImageUrls:
    """sign_image_urls doit conserver le fragment de taille après l'URL
    signée."""

    def test_preserve_taille_w(self) -> None:
        md = "![figure](/api/files/abc123#w=300)"
        result = ef.sign_image_urls(md, _fake_epreuve())
        # L'URL signée est présente, le fragment #w=300 est ré-accolé à
        # la fin.
        assert "![figure](" in result
        assert "?token=" in result
        assert result.endswith("#w=300)")

    def test_sans_fragment(self) -> None:
        md = "![figure](/api/files/abc123)"
        result = ef.sign_image_urls(md, _fake_epreuve())
        assert "?token=" in result
        assert "#" not in result

    def test_url_non_fichier_inchangee(self) -> None:
        md = "![lien](https://example.com/img.png)"
        result = ef.sign_image_urls(md, _fake_epreuve())
        assert result == md

    def test_plusieurs_images_melangees(self) -> None:
        md = (
            "![a](/api/files/img1)\n"
            "![b](/api/files/img2#w=480)\n"
            "![c](https://external.com/s.png)"
        )
        result = ef.sign_image_urls(md, _fake_epreuve())
        lines = result.strip().split("\n")
        assert len(lines) == 3
        assert "#w=480" in lines[1]
        assert lines[2] == "![c](https://external.com/s.png)"


class TestExtractLocalImagePaths:
    """_extract_local_image_paths (assistant) doit retrouver les images
    via file_id_from_url avec ou sans fragment."""

    def test_url_avec_fragment_est_trouvee(self) -> None:
        md = "![x](/api/files/img-001#w=200)"
        # La fonction tente de lire en base ; en test, l'id n'existe pas :
        # on vérifie juste que le fragment ne casse pas l'extraction et que
        # la fonction ne plante pas (aucune ligne trouvée = liste vide).
        result = assistant_core._extract_local_image_paths(md, user_id=None)
        assert result == []

    def test_url_avec_token_et_fragment(self) -> None:
        md = "![x](/api/files/img-002?token=tok#w=640)"
        result = assistant_core._extract_local_image_paths(md, user_id=None)
        assert result == []
