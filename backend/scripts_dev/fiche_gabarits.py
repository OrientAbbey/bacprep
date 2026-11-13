"""Fiche de relecture des gabarits d'entraînement, à remettre à un enseignant (voir docs/RELECTURE_GABARITS.md).

Génère, depuis les fichiers de `app/gabarits/` (donc toujours à jour) :
  - une fiche CSV à remplir (Excel / LibreOffice, séparateur « ; ») : une ligne par gabarit, les colonnes « décision » vides ;
  - le tableau de COUVERTURE (matière → chapitre → classes visées) en Markdown, affiché à l'écran.

    cd backend && python scripts_dev/fiche_gabarits.py /tmp/fiche_validation_gabarits.csv

Hors CI. Ne touche à aucune base : la validation se fait dans l'onglet « Exercices types » du back-office."""
from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

COLONNES = ["id", "titre", "matiere", "classes", "chapitre", "difficulte", "points", "variantes_relues", "programme", "enonce", "niveau", "correction", "decision", "remarques"]
COLONNES_SAISIE = COLONNES[7:]
DECISIONS = ("valider", "modifier", "écarter")
AIDE = {
    "variantes_relues": "Combien de variantes avez-vous ouvertes (aperçu avec correction) ? Au moins 3 par exercice.",
    "programme": "Cette notion est-elle au programme de la classe indiquée ? oui / non / autre classe (laquelle ?)",
    "enonce": "L'énoncé est-il clair, correct, bien rédigé, sans ambiguïté ? oui / non (que changer ?)",
    "niveau": "Le niveau de difficulté est-il adapté à la classe ? oui / trop facile / trop difficile",
    "correction": "La correction (réponse et méthode) est-elle juste ET présentée comme on l'enseigne ? oui / non (quoi ?)",
    "decision": "valider / modifier / écarter",
    "remarques": "Tout ce qui est utile : notation à changer, contexte à adapter, variante qui pose problème (notez son numéro)…",
}


def lignes() -> list[dict]:
    from app.core import gabarits as g

    valides, erreurs = g.charger_dossier()
    if erreurs:
        raise SystemExit(f"Fichiers de gabarits invalides, fiche non générée : {erreurs}")
    res = []
    for gid, gab in sorted(valides.items(), key=lambda kv: (kv[1].matiere, kv[1].chapitre, kv[1].difficulte, kv[1].titre)):
        res.append({"id": gid, "titre": gab.titre, "matiere": gab.matiere, "classes": ", ".join(gab.classes), "chapitre": gab.chapitre,
                    "difficulte": gab.difficulte, "points": f"{float(gab.total_points):g}".replace(".", ","), **{c: "" for c in COLONNES_SAISIE}})
    return res


def ecrire_csv(chemin: Path, rows: list[dict] | None = None) -> None:
    # utf-8-sig + « ; » : s'ouvre correctement dans Excel / LibreOffice en français
    with chemin.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLONNES, delimiter=";", extrasaction="ignore")
        w.writeheader()
        w.writerows(rows if rows is not None else lignes())


def couverture(rows: list[dict] | None = None) -> str:
    """Tableau Markdown matière → chapitre → exercices et classes visées."""
    rows = rows if rows is not None else lignes()
    sortie = ["| Matière | Chapitre | Exercices | Classes visées |", "|---|---|---|---|"]
    groupes: dict[tuple[str, str], list[dict]] = {}
    for r in rows:
        groupes.setdefault((r["matiere"], r["chapitre"]), []).append(r)
    for (matiere, chapitre), exos in groupes.items():
        classes = sorted({c for e in exos for c in e["classes"].split(", ")})
        sortie.append(f"| {matiere} | {chapitre} | {len(exos)} | {', '.join(classes)} |")
    return "\n".join(sortie) + "\n"


def main(argv: list[str] | None = None) -> int:
    args = (argv if argv is not None else sys.argv[1:])
    if len(args) != 1:
        print("Usage : python scripts_dev/fiche_gabarits.py <fichier.csv>", file=sys.stderr)
        return 2
    rows = lignes()
    ecrire_csv(Path(args[0]), rows)
    print(couverture(rows))
    print(f"{len(rows)} exercices écrits dans {args[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
