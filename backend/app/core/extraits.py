"""Génération des extraits de présentation des épreuves (cartes du
catalogue). Un extrait = les premières lignes de texte lisible du sujet,
sans frontmatter, titres, images, tableaux ni formules LaTeX — tronqué à
deux lignes environ (280 caractères, coupé au dernier espace)."""

import re

_MAX_LEN = 280

# Référence Markdown d'image, avec ses deux groupes utiles : (1) l'alt,
# (2) l'URL. Source unique pour la génération d'extraits (ici), la
# signature des URLs (core/epreuve_files) et l'extraction d'images pour le
# LLM (core/assistant) — une seule regex à maintenir.
IMAGE_MD_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")

# Ordre de nettoyage : ce qui doit disparaître en premier d'abord.
# (motif, remplacement) — le remplacement explicite évite de deviner le
# comportement en inspectant la source du motif.
_PATTERNS = [
    (re.compile(r"^---\n.*?\n---\n", re.DOTALL), ""),  # frontmatter
    (re.compile(r"```[\s\S]*?```"), ""),  # blocs de code
    (IMAGE_MD_RE, ""),  # images (même regex que la signature/le LLM)
    (re.compile(r"\$\$[\s\S]*?\$\$"), ""),  # LaTeX bloc
    (re.compile(r"\$[^$\n]+\$"), ""),  # LaTeX inline
    (re.compile(r"^\s*\|.*\|\s*$", re.MULTILINE), ""),  # tableaux
    (re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE), ""),  # titres markdown
    (re.compile(r"\{#[^}]*\}"), ""),  # ancres {#id}
    (re.compile(r"\*\*?|__?|`"), ""),  # emphase / code inline
    (re.compile(r"^\s*[-*+]\s+", re.MULTILINE), ""),  # puces
    (re.compile(r"\n{2,}"), " "),  # paragraphes -> espace
]


def build_extrait(markdown: str) -> str:
    """Extrait un aperçu texte brut du contenu Markdown fourni."""
    text = markdown or ""
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= _MAX_LEN:
        return text
    cut = text[:_MAX_LEN]
    # Coupure au dernier espace pour ne pas trancher un mot.
    cut = cut[: cut.rfind(" ")] if " " in cut else cut
    return cut.rstrip(" ,;:.") + "…"
