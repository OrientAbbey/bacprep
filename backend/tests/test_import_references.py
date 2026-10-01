"""Non-régression de l'import massif : les deux défauts corrigés en Phase 0 du
plan `PLAN_SAUVEGARDES.md`.

1. Un contenu identique partagé entre épreuves était **écarté** (détection de
   doublon par checksum globale) : perte de fichier silencieuse.
2. Les références d'images Markdown n'étaient réécrites que pour la forme
   `![](image.png)` : les autres formes laissaient des images cassées, sans
   qu'aucune ligne de rapport ne le signale.

Ces testsProtègent aussi la réimportation du même lot, qui reste sans effet
grâce aux contrôles LOGIQUES (même épreuve + même cible) — le retrait du
blocage par contenu ne doit donc pas créer de doublons.
"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from app.core.import_service import _rewrite_image_refs, run_import
from app.core.storage import get_storage
from app.db import SessionLocal
from app.db_models import EpreuveFileORM


@pytest.fixture()
def db_prete(client):
    """Session SQLAlchemy sur une base dont les tables existent.

    Le fixture `db` de conftest se contente d'ouvrir une session ; les tables
    sont créées par le lifespan de l'app. Déclarer `client` le déclenche — c'est
    aussi la convention du projet (les tests qui interrogent `epreuve_files`
    passent tous par un fixture dérivé de `client`).
    """
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _png(color=(255, 0, 0)) -> bytes:
    """Petite image PNG valide, lisible par Pillow."""
    buf = BytesIO()
    Image.new("RGB", (8, 8), color).save(buf, format="PNG")
    return buf.getvalue()


def _arbre(root: Path, dossiers: list[str], images_partagees: bool, annee: str) -> None:
    """Construit une arborescence d'import `{annee}/{classe}/{matiere}/`.

    `images_partagees` met la MÊME image dans chaque dossier : c'est le cas
    d'usage légitime qui était bloqué (un logo commun à plusieurs épreuves).

    `annee` varie d'un test à l'autre : l'identité d'une épreuve importée est
    (niveau, classe, évaluation, matière, année) et la base de test est
    partagée, donc une année par test évite toute contamination entre tests.
    """
    for i, matiere in enumerate(dossiers):
        dossier = root / annee / "terminale" / matiere
        dossier.mkdir(parents=True, exist_ok=True)
        figure = "logo.png" if images_partagees else f"figure{i}.png"
        (dossier / figure).write_bytes(_png((0, 128 * (i + 1), 255)))
        # Formes de référence volontairement variées : les trois premières
        # doivent être réécrites, la quatrième (lien de référence) doit être
        # COMPTÉE sans être réécrite.
        (dossier / "epreuve-sujet.md").write_text(
            "# Sujet\n"
            "\n"
            "![](../logo.png)\n"
            f"![alt](./{figure})\n"
            f'![titre](figures/{figure} "légende")\n'
            '<img src="image/logo.png" />\n'
            "\n"
            "![ref][r1]\n"
            "\n"
            f"[r1]: {figure}\n",
            encoding="utf-8",
        )


# --------------------------------------------------------------------------
# 1. Réécriture des références d'images
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "source,attendu",
    [
        ("![alt](figure.png)", "![alt](/api/files/ABC)"),
        ("![alt](./figure.png)", "![alt](/api/files/ABC)"),
        ("![](figure.png)", "![](/api/files/ABC)"),
        ('![alt](figure.png "légende")', '![alt](/api/files/ABC "légende")'),
        ("![alt](figures/figure.png)", "![alt](/api/files/ABC)"),
        ('<img src="figure.png" />', '<img src="/api/files/ABC" />'),
        ("<img src='figure.png'>", "<img src='/api/files/ABC'>"),
    ],
)
def test_reference_image_reecrite(source: str, attendu: str) -> None:
    contenu, n, restant = _rewrite_image_refs(source, "figure.png", "/api/files/ABC")
    assert contenu == attendu
    assert n == 1
    assert restant == 0


def test_prefixe_similaire_non_confondu() -> None:
    """`a.png` ne doit pas matcher dans `xa.png` ni dans `a.pngx`."""
    source = "![1](xa.png)\n![2](a.pngx)\n![3](a.png)\n"
    contenu, n, restant = _rewrite_image_refs(source, "a.png", "/api/files/ABC")
    assert contenu == "![1](xa.png)\n![2](a.pngx)\n![3](/api/files/ABC)\n"
    assert n == 1
    assert restant == 0


def test_lien_de_reference_non_reecrit_mais_compte() -> None:
    """`![alt][r1]` + `[r1]: figure.png` n'est pas réécrit, mais COMPTE.

    C'est le point du correctif : une image cassée doit être visible dans le
    rapport, pas passer en silence.
    """
    source = "![ref][r1]\n\n[r1]: figure.png\n"
    contenu, n, restant = _rewrite_image_refs(source, "figure.png", "/api/files/ABC")
    assert n == 0
    assert restant == 1
    assert "[r1]: figure.png" in contenu


def test_document_sans_reference_inchange() -> None:
    source = "# Sujet\n\nAucune image ici.\n"
    contenu, n, restant = _rewrite_image_refs(source, "figure.png", "/api/files/ABC")
    assert contenu == source
    assert (n, restant) == (0, 0)


# --------------------------------------------------------------------------
# 2. Contenu partagé entre épreuves
# --------------------------------------------------------------------------


def test_image_partagee_importee_dans_chaque_epreuve(db_prete, tmp_path) -> None:
    """Deux épreuves partageant la MÊME image : les deux doivent l'avoir."""
    _arbre(tmp_path, ["Mathématiques", "Physique-Chimie"], images_partagees=True, annee="2021")
    rapport = run_import(db_prete, tmp_path)

    assert rapport["erreurs"] == [], rapport["erreurs"]
    assert rapport["epreuves_creees"] == 2
    assert rapport["images_importees"] == 2, rapport

    logos = (
        db_prete.query(EpreuveFileORM)
        .filter(EpreuveFileORM.format == "image", EpreuveFileORM.filename == "logo.png")
        .all()
    )
    assert len(logos) == 2, "l'image partagée doit exister dans les DEUX épreuves"
    # Le partage est signalé comme information, pas comme doublon.
    assert rapport["doublons"] == []
    assert rapport["contenus_partages_count"] >= 1


def test_reference_image_reecrite_apres_import(db_prete, tmp_path) -> None:
    """Le Markdown stocké pointe vers l'URL contrôlée, pas vers le nom de fichier."""
    _arbre(tmp_path, ["Mathématiques"], images_partagees=True, annee="2022")
    rapport = run_import(db_prete, tmp_path)
    assert rapport["erreurs"] == [], rapport["erreurs"]

    # La clé est lue dans le rapport : la base étant partagée entre tests,
    # cibler « le seul sujet » par un `.one()` serait fragile.
    sujet = next(c for c in rapport["creees"] if c["cible"] == "sujet")
    contenu = get_storage().get_bytes(sujet["storage_key"]).decode("utf-8")
    assert "](/api/files/" in contenu
    assert "![alt](./logo.png)" not in contenu
    assert '![titre](figures/logo.png "légende")' not in contenu
    # Le lien de référence n'est pas réécrit, mais il est compté : c'est la
    # garantie qu'un cas non couvert ne disparaît plus en silence.
    rapport2 = run_import(db_prete, tmp_path)
    # Une réimportation est refusée par le contrôle LOGIQUE (même épreuve,
    # même cible) — et signalée comme doublon, ce qui est le comportement voulu.
    assert rapport2["creees"] == []
    assert len(rapport2["doublons"]) == 1


def test_reimport_meme_lot_ne_duplique_pas(db_prete, tmp_path) -> None:
    """Régression : retirer le blocage par checksum ne doit pas créer de doublons.

    Le même lot réimporté retrouve la même épreuve et la même cible, donc les
    contrôles logiques suffisent à neutraliser la seconde passe.
    """
    _arbre(tmp_path, ["Mathématiques"], images_partagees=True, annee="2023")
    run_import(db_prete, tmp_path)
    avant = db_prete.query(EpreuveFileORM).count()

    rapport = run_import(db_prete, tmp_path)
    assert db_prete.query(EpreuveFileORM).count() == avant
    assert rapport["creees"] == []
    assert rapport["images_importees"] == 0
    assert rapport["epreuves_creees"] == 0

