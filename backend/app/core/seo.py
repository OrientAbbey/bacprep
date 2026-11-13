"""SEO et aperçus de partage (WhatsApp, Facebook…) pour une application à
page unique : le navigateur n'exécute pas le JavaScript d'un aperçu de lien,
donc le serveur injecte lui-même le titre et la description dans index.html
pour les pages d'épreuve, et publie robots.txt / sitemap.xml.

`evolution` fait de même avec un `render_index` qui suppose une image de
partage nommée `og-image.png`. `refonte` n'a pas ce fichier : son index.html
déclare `/icon-512.png`. On ne fige donc pas le nom de l'image : la valeur
présente dans le template est rendue ABSOLUE, quel que soit son nom.
"""
from __future__ import annotations

import html
import os
import re

from fastapi import Request
from sqlalchemy.orm import Session

from ..db_models import EpreuveORM
from .referentiel import CLASSES_LABELS

_TITLE_RE = re.compile(r"<title>.*?</title>", re.S)
_META_RE = {
    "description": re.compile(r'(<meta name="description" content=")[^"]*(")'),
    "og:title": re.compile(r'(<meta property="og:title" content=")[^"]*(")'),
    "og:description": re.compile(r'(<meta property="og:description" content=")[^"]*(")'),
}
# Groupes : 1 = avant la valeur, 2 = valeur courante, 3 = guillemet fermant.
_OG_IMAGE_RE = re.compile(r'(<meta property="og:image" content=")([^"]*)(")')
_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")

# Pages publiques stables de l'application (React Router), en plus de l'accueil
# et des épreuves publiées. Les pages de la console admin n'y figurent jamais :
# robots.txt les exclut et elles exigent une session.
PAGES_STATIQUES = ("/catalogue", "/aide", "/a-propos", "/confidentialite", "/conditions")

# Le sitemap est un plan de crawl, pas un export : 5 000 URL suffisent très
# largement pour un catalogue de quelques milliers d'épreuves.
LIMITE_SITEMAP = 5000


def base_url(request: Request) -> str:
    """URL publique du site : PUBLIC_BASE_URL si définie (recommandé derrière
    un proxy), sinon celle de la requête."""
    return (os.getenv("PUBLIC_BASE_URL", "").strip() or str(request.base_url)).rstrip("/")


def _titre(e: EpreuveORM) -> str:
    """« Mathématiques 2024 — BAC (Terminale) » : ce que lit un élève dans
    l'aperçu de partage, sans code technique (`terminale`)."""
    classe = CLASSES_LABELS.get(e.classe, (e.classe or "").replace("_", " "))
    return f"{e.matiere} {e.annee} — {e.evaluation} ({classe})"


def _absolue(valeur: str, base: str) -> str:
    """Rend une URL d'attribut absolue : les aperçus de lien n'ont pas de page
    d'origine, donc un `/icon-512.png` relatif n'est pas résolu."""
    valeur = valeur.strip()
    if not valeur or _SCHEME_RE.match(valeur) or valeur.startswith("//"):
        return valeur
    return f"{base}/{valeur.lstrip('/')}"


def render_index(template: str, request: Request, epreuve: EpreuveORM | None = None) -> str:
    """index.html avec image de partage absolue et, pour une épreuve publiée,
    son titre et sa description."""
    base = base_url(request)

    def image(m: re.Match[str]) -> str:
        return f"{m[1]}{html.escape(_absolue(m[2], base))}{m[3]}"

    out = _OG_IMAGE_RE.sub(image, template)
    if epreuve is None:
        return out
    titre = html.escape(f"{_titre(epreuve)} | Copies & Corrigés")
    desc = html.escape(
        f"Sujet et corrigé : {_titre(epreuve)}. Épreuves du secondaire camerounais."
    )
    out = _TITLE_RE.sub(lambda _m: f"<title>{titre}</title>", out, count=1)
    for cle, valeur in (("description", desc), ("og:title", titre), ("og:description", desc)):
        out = _META_RE[cle].sub(lambda m, v=valeur: f"{m[1]}{v}{m[2]}", out)
    return out


def published_epreuve(db: Session, epreuve_id: str) -> EpreuveORM | None:
    """Une épreuve non publiée n'existe pas pour le public : elle ne doit
    jamais apparaître dans un aperçu de partage ni dans le sitemap."""
    return (
        db.query(EpreuveORM)
        .filter(EpreuveORM.id == epreuve_id, EpreuveORM.statut == "publie")
        .one_or_none()
    )


def robots_txt(request: Request) -> str:
    """La console admin et l'API ne sont pas du contenu à indexer."""
    return (
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /api/\n"
        "Disallow: /admin\n"
        f"Sitemap: {base_url(request)}/sitemap.xml\n"
    )


def sitemap_xml(db: Session, request: Request) -> str:
    base = base_url(request)
    ids = [
        eid
        for (eid,) in db.query(EpreuveORM.id)
        .filter(EpreuveORM.statut == "publie")
        .order_by(EpreuveORM.annee.desc())
        .limit(LIMITE_SITEMAP)
    ]
    urls = [f"{base}/"] + [f"{base}{page}" for page in PAGES_STATIQUES]
    urls += [f"{base}/epreuve/{eid}" for eid in ids]
    corps = "".join(f"<url><loc>{html.escape(u)}</loc></url>" for u in urls)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        f"{corps}</urlset>"
    )
