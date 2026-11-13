"""Lot G — SEO : aperçus de partage injectés côté serveur, robots.txt et
sitemap.xml.

Un aperçu de lien (WhatsApp, Facebook, Telegram…) n'exécute jamais le
JavaScript de l'application : seul le HTML renvoyé par le serveur est lu.
D'où ces tests sur le HTML **réellement servi** en plus de ceux sur les
fonctions de `core.seo`.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET

import pytest


INDEX = (
    '<html><head><title>Copies &amp; Corrigés — annales et corrigés du secondaire camerounais</title>'
    '<meta name="description" content="x" />'
    '<meta property="og:title" content="x" /><meta property="og:description" content="x" />'
    '<meta property="og:image" content="/icon-512.png" /></head><body></body></html>'
)

_NS = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}


@pytest.fixture()
def requete():
    """Fabrique de vraies requêtes Starlette (base_url = https://bacprep.test)."""
    from starlette.requests import Request

    def make(path="/", host="bacprep.test"):
        return Request(
            {
                "type": "http",
                "method": "GET",
                "path": path,
                "headers": [(b"host", host.encode())],
                "scheme": "https",
                "server": (host, 443),
                "query_string": b"",
            }
        )

    return make


# --------------------------------------------------------------------------
# Injection dans index.html
# --------------------------------------------------------------------------


def test_image_de_partage_rendue_absolue(requete):
    """L'aperçu n'a pas de page d'origine : `/icon-512.png` ne serait pas
    résolu. La fonction conserve le NOM du fichier du template (refonte
    n'embarque pas d'og-image.png dédiée)."""
    from app.core import seo

    html = seo.render_index(INDEX, requete())
    assert 'content="https://bacprep.test/icon-512.png"' in html


def test_image_de_partage_deja_absolue_inchangee(requete):
    from app.core import seo

    html = seo.render_index(INDEX.replace("/icon-512.png", "https://cdn.test/a.png"), requete())
    assert 'content="https://cdn.test/a.png"' in html


def test_epreuve_publiee_titre_et_description(requete, db, epreuve_gratuite):
    from app.core import seo

    e = seo.published_epreuve(db, epreuve_gratuite)
    assert e is not None
    html = seo.render_index(INDEX, requete(), e)
    # Classe lisible (« Terminale »), jamais le code technique (« terminale »).
    assert "<title>Mathématiques 2024 — BAC (Terminale) | Copies &amp; Corrigés</title>" in html
    assert 'content="Sujet et corrigé : Mathématiques 2024 — BAC (Terminale).' in html
    assert 'property="og:title" content="Mathématiques 2024 — BAC (Terminale) | Copies &amp; Corrigés"' in html
    # Le titre générique du gabarit a bien été remplacé, pas dupliqué.
    assert html.count("<title>") == 1


def test_epreuve_inconnue_ou_non_publiee_sans_meta(requete, admin, db, epreuve_gratuite):
    from app.core import seo

    assert seo.published_epreuve(db, "inexistante") is None
    r = admin.post(
        "/api/admin/epreuves",
        json={
            "niveau": "SECONDAIRE",
            "classe": "3e",
            "evaluation": "BEPC",
            "matiere": "Histoire",
            "annee": "2023",
            "gratuit": True,
            "filieres": [],
            "contenu_markdown": "# Brouillon",
        },
    )
    assert r.status_code == 200, r.text
    brouillon = r.json()["id"]
    # Créée mais JAMAIS publiée : elle n'existe pas pour le public.
    assert seo.published_epreuve(db, brouillon) is None
    html = seo.render_index(INDEX, requete(), None)
    assert "annales et corrigés du secondaire camerounais" in html and "Histoire" not in html


def test_html_echappe_les_metadonnees(requete, db, epreuve_gratuite):
    """Une matière saisie librement ne doit pas pouvoir injecter de balise
    dans l'en-tête servi aux robots et aux aperçus."""
    from app.core import seo

    e = seo.published_epreuve(db, epreuve_gratuite)
    e.matiere = '<script>alert(1)</script>"'
    try:
        html = seo.render_index(INDEX, requete(), e)
        assert "<script>alert(1)</script>" not in html
        assert "&lt;script&gt;" in html and "&quot;" in html
    finally:
        db.rollback()


def test_base_publique_prioritaire_sur_la_requete(requete, monkeypatch):
    from app.core import seo

    monkeypatch.setenv("PUBLIC_BASE_URL", "https://exemple.cm/")
    assert seo.base_url(requete()) == "https://exemple.cm"
    assert "https://exemple.cm/icon-512.png" in seo.render_index(INDEX, requete())


# --------------------------------------------------------------------------
# robots.txt et sitemap.xml
# --------------------------------------------------------------------------


def test_robots_txt(client, monkeypatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://exemple.cm")
    r = client.get("/robots.txt")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    corps = r.text
    assert corps.startswith("User-agent: *")
    assert "Disallow: /api/" in corps and "Disallow: /admin" in corps
    assert "Sitemap: https://exemple.cm/sitemap.xml" in corps


def test_sitemap_xml_valide_et_complet(client, monkeypatch, epreuve_gratuite, db):
    from app.core import seo
    from app.db_models import EpreuveORM

    monkeypatch.setenv("PUBLIC_BASE_URL", "https://exemple.cm")
    r = client.get("/sitemap.xml")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/xml")
    racine = ET.fromstring(r.text)  # XML bien formé, sinon lxml lève
    urls = [loc.text for loc in racine.findall("s:url/s:loc", _NS)]
    assert urls[0] == "https://exemple.cm/"
    for page in seo.PAGES_STATIQUES:
        assert f"https://exemple.cm{page}" in urls
    assert f"https://exemple.cm/epreuve/{epreuve_gratuite}" in urls
    # Un brouillon n'a rien à faire dans un plan de crawl : il renvoie 404 au
    # visiteur et ferait indexer du vide.
    brouillon = db.query(EpreuveORM).filter(EpreuveORM.statut != "publie").first()
    if brouillon is not None:
        assert f"https://exemple.cm/epreuve/{brouillon.id}" not in urls


def test_sitemap_xml_echappe_les_urls(client, monkeypatch, db, epreuve_gratuite):
    """Même avec une base restaurée hors application, le plan de crawl doit
    rester du XML bien formé : toute URL est échappée."""
    from app.core import seo

    monkeypatch.setenv("PUBLIC_BASE_URL", "https://exemple.cm")
    ET.fromstring(seo.sitemap_xml(db, _fausse_requete()))


def _fausse_requete():
    from starlette.requests import Request

    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/sitemap.xml",
            "headers": [(b"host", b"bacprep.test")],
            "scheme": "https",
            "server": ("bacprep.test", 443),
            "query_string": b"",
        }
    )


# --------------------------------------------------------------------------
# Contrat d'API et HTML réellement servi
# --------------------------------------------------------------------------


def test_api_inconnue_reste_une_404_json(client):
    """Régression classique d'un attrape-tout : `/api/inconnu` renverrait
    index.html (200) et le frontend échouerait sur `response.json()`."""
    for chemin in ("/api/inconnu", "/api"):
        r = client.get(chemin)
        assert r.status_code == 404, chemin
        assert r.headers["content-type"].startswith("application/json"), chemin
        assert "detail" in r.json()


def test_page_epreuve_servie_avec_titre_et_image_absolue(client, epreuve_gratuite, monkeypatch):
    """Bout en bout : la route cliente `/epreuve/{id}` renvoie le HTML avec
    les métadonnées de l'épreuve. Ignoré si le frontend n'est pas compilé
    (les fonctions ci-dessus couvrent alors le rendu)."""
    import app.main as m

    if not (m.FRONTEND_DIST / "index.html").exists():
        pytest.skip("frontend non compilé")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://exemple.cm")
    r = client.get(f"/epreuve/{epreuve_gratuite}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert "no-cache" in r.headers.get("cache-control", "")
    assert "<title>Mathématiques 2024 — BAC (Terminale)" in r.text
    assert 'content="https://exemple.cm/icon-512.png"' in r.text
    # La page inconnue garde le titre générique mais la même og:image absolue.
    r = client.get("/epreuve/inconnue-xyz")
    assert r.status_code == 200
    assert "<title>Mathématiques 2024" not in r.text
    assert 'content="https://exemple.cm/icon-512.png"' in r.text
