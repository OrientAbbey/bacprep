"""Vérification INDÉPENDANTE des gabarits d'exercices (hors serveur de production : SymPy n'est qu'une dépendance de développement).

Pour chaque gabarit et chaque graine, on RECALCULE les réponses par un autre chemin que celui du gabarit — SymPy (dérivée, discriminant, somme, limite, intégrale,
module…) ou énumération brute (tirages d'une urne) — et on compare aux grandeurs nommées du gabarit. On vérifie aussi que chaque résultat est bien AFFICHÉ dans la
réponse rendue : le texte et le calcul ne peuvent donc pas diverger.

Règle d'écriture d'un gabarit : tout nombre qui apparaît dans une réponse vient d'une grandeur nommée (`calculs`), que la fonction de vérification ci-dessous recalcule.
Un gabarit sans fonction de vérification ici est refusé par les tests. Usage : `python scripts_dev/verif_gabarits.py [nb_graines]` (défaut 100).
"""
from __future__ import annotations

import itertools
import sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _s(sp, x: Fraction):
    return sp.Rational(x.numerator, x.denominator)


def verifier(gab, graine: int) -> list[str]:
    """Liste des désaccords pour cette graine (vide = tout est cohérent)."""
    import sympy as sp

    from app.core import gabarits as g

    env = gab.tirer(graine)
    inst = gab.instancier(graine)
    S = {k: _s(sp, v) for k, v in env.items()}
    x = sp.symbols("x")
    erreurs: list[str] = []

    def egal(nom: str, obtenu, attendu) -> None:
        if sp.simplify(sp.sympify(obtenu) - sp.sympify(attendu)) != 0:
            erreurs.append(f"{nom} : gabarit {obtenu} ≠ recalcul {attendu}")

    def affiche(question: int, valeur: Fraction | str, ou: str = "reponse") -> None:
        """La valeur doit apparaître, mise en forme comme le fait le gabarit, dans le texte rendu."""
        attendu = g._tex(valeur) if isinstance(valeur, Fraction) else valeur
        if attendu not in inst["corrections"][question][ou]:
            erreurs.append(f"question {question + 1} : « {attendu} » n'apparaît pas dans {ou}")

    gid = gab.id
    if gid == "derivee-polynome-degre-3":
        f = S["a"] * x**3 + S["b"] * x**2 + S["c"] * x + S["d"]
        fp = sp.diff(f, x)
        if sp.Poly(fp, x).all_coeffs() != [S["d3"], S["d2"], S["c"]]:
            erreurs.append("coefficients de f' différents")
        egal("f'(x0)", S["fp0"], fp.subs(x, S["x0"]))
        egal("f(x0)", S["f0"], f.subs(x, S["x0"]))
        tangente = sp.expand(fp.subs(x, S["x0"]) * (x - S["x0"]) + f.subs(x, S["x0"]))
        if (tangente.coeff(x, 1), tangente.coeff(x, 0)) != (S["fp0"], S["p"]):  # par degré : une tangente horizontale est de degré 0
            erreurs.append("tangente différente")
        affiche(1, env["fp0"]); affiche(2, g._poly(env["fp0"], env["p"]))  # l'équation y = f'(x0) x + p complète, telle qu'affichée
    elif gid == "equation-second-degre-racines-entieres":
        eq = S["a"] * x**2 + S["b"] * x + S["c"]
        egal("discriminant", S["delta"], sp.discriminant(eq, x))
        if set(sp.solve(eq, x)) != {S["r1"], S["r2"]}:
            erreurs.append(f"solutions de {eq}")
        affiche(0, env["delta"]); affiche(1, env["r1"]); affiche(1, env["r2"])
    elif gid == "suite-arithmetique":
        k = sp.symbols("k", integer=True)
        egal("u_n", S["un"], S["u0"] + S["n"] * S["r"])
        egal("somme", S["somme"], sp.summation(S["u0"] + k * S["r"], (k, 0, S["n"])))
        affiche(1, env["un"]); affiche(2, env["somme"])
    elif gid == "suite-geometrique":
        k = sp.symbols("k", integer=True)
        egal("v_n", S["un"], S["u0"] * S["q"] ** S["n"])
        egal("somme", S["somme"], sp.summation(S["u0"] * S["q"] ** k, (k, 0, S["n"])))
        affiche(1, env["un"]); affiche(2, env["somme"])
    elif gid == "limite-fraction-rationnelle":
        f = (S["a"] * x**2 + S["b"] * x + S["c"]) / (S["d"] * x**2 + S["e"] * x + S["g"])
        egal("limite en +∞", S["lim"], sp.limit(f, x, sp.oo))
        affiche(0, env["lim"]); affiche(1, env["lim"])
    elif gid == "integrale-polynome":
        f = S["a"] * x**2 + S["b"] * x + S["c"]
        F = S["pa"] * x**3 + S["pb"] * x**2 + S["c"] * x
        egal("F' = f", sp.diff(F, x), f)
        egal("intégrale", S["vi"], sp.integrate(f, (x, 0, S["k"])))
        affiche(1, env["vi"])
    elif gid == "probabilite-urne":
        boules = ["R"] * int(env["r"]) + ["V"] * int(env["v"]) + ["B"] * int(env["bl"])
        paires = list(itertools.combinations(range(len(boules)), 2))
        egal("nombre de tirages", S["pairs"], len(paires))
        egal("P(rouge)", S["pr"], sp.Rational(int(env["r"]), len(boules)))
        meme = sum(1 for i, j in paires if boules[i] == boules[j])
        rv = sum(1 for i, j in paires if {boules[i], boules[j]} == {"R", "V"})
        egal("même couleur", S["pm"], sp.Rational(meme, len(paires)))
        egal("rouge et verte", S["prv"], sp.Rational(rv, len(paires)))
        affiche(0, env["pr"]); affiche(1, env["pm"]); affiche(2, env["prv"])
    elif gid == "nombres-complexes-produit-module":
        z1, z2 = S["a"] + S["b"] * sp.I, S["c"] + S["d"] * sp.I
        egal("partie réelle de z1 z2", S["pr"], sp.re(sp.expand(z1 * z2)))
        egal("partie imaginaire de z1 z2", S["pi"], sp.im(sp.expand(z1 * z2)))
        egal("z1 conj(z1)", S["mod2"], sp.expand(z1 * sp.conjugate(z1)))
        egal("module de w", S["h"], sp.Abs(S["p"] + S["q"] * sp.I))
        affiche(1, env["mod2"]); affiche(2, env["h"])
    elif gid == "droite-deux-points":
        A, B = sp.Point(S["xa"], S["ya"]), sp.Point(S["xb"], S["yb"])
        droite = sp.Line(A, B)
        egal("coefficient directeur", S["m"], droite.slope)
        y = sp.Symbol("y")
        egal("ordonnée à l'origine", S["p"], sp.solve(droite.equation(x, y), y)[0].subs(x, 0))
        appartient = droite.contains(sp.Point(S["xc"], S["yc"]))
        if bool(appartient) != (env["sur"] == 1):
            erreurs.append("appartenance de C à la droite")
        affiche(0, env["m"]); affiche(1, env["p"], "etapes")
    elif gid == "mouvement-rectiligne-uniformement-varie":
        t = sp.symbols("t")
        vitesse = S["v0"] + S["acc"] * t
        egal("vitesse", S["v"], vitesse.subs(t, S["t"]))
        egal("distance", S["dist"], sp.integrate(vitesse, (t, 0, S["t"])))
        egal("km/h", S["vkmh"], S["v"] * sp.Rational(3600, 1000))
    elif gid == "association-resistances-loi-ohm":
        egal("série", S["rs"], S["r1"] + S["r2"])
        egal("parallèle", S["rp"], 1 / (1 / S["r1"] + 1 / S["r2"]))
        egal("intensité", S["i"], S["u"] / (S["r1"] + S["r2"]))
    elif gid == "tontine-cotisation-croissante":
        k = sp.symbols("k", integer=True)
        egal("u_n", S["un"], S["u1"] + (S["n"] - 1) * S["r"])
        egal("total versé", S["total"], sp.summation(S["u1"] + (k - 1) * S["r"], (k, 1, S["n"])))
        affiche(1, g._milliers_tex(env["un"])); affiche(2, g._milliers_tex(env["total"]))
    elif gid == "placement-interets-composes":
        q = 1 + sp.Rational(int(env["t"]), 100)
        egal("raison", S["q"], q)
        egal("capital après n années", S["cn"], S["c0"] * q ** S["n"])
        egal("arrondi au franc", S["cn_arr"], sp.floor(S["c0"] * q ** S["n"] + sp.Rational(1, 2)))
        affiche(0, g._decimal(env["q"])); affiche(2, g._milliers_tex(env["cn_arr"]))
    elif gid == "benefice-maximal-commerce":
        from sympy.calculus.util import maximum

        B = -S["a"] * x**2 + S["b1"] * x - S["c"]
        Bp = sp.diff(B, x)
        if sp.Poly(Bp, x).all_coeffs() != [S["d1"], S["d0"]]:
            erreurs.append("coefficients de B' différents")
        if sp.solve(Bp, x) != [S["xs"]]:
            erreurs.append("B'(x) = 0 n'a pas pour unique solution xs")
        if not sp.diff(B, x, 2) < 0:
            erreurs.append("B n'est pas concave")
        egal("bénéfice maximal", S["bmax"], B.subs(x, S["xs"]))
        egal("maximum sur [0 ; 2 xs]", S["bmax"], maximum(B, x, sp.Interval(0, 2 * S["xs"])))
        affiche(2, g._milliers_tex(env["bfcfa"]))
    elif gid == "delegues-classe-probabilites":
        eleves = ["F"] * int(env["f"]) + ["G"] * int(env["g"])
        paires = list(itertools.combinations(range(len(eleves)), 2))
        deux_f = sum(1 for i, j in paires if eleves[i] == eleves[j] == "F")
        une_de_chaque = sum(1 for i, j in paires if {eleves[i], eleves[j]} == {"F", "G"})
        au_moins_une_f = sum(1 for i, j in paires if "F" in (eleves[i], eleves[j]))
        egal("nombre de choix", S["pairs"], len(paires))
        egal("deux filles", S["p2f"], sp.Rational(deux_f, len(paires)))
        egal("un garçon et une fille", S["pfg"], sp.Rational(une_de_chaque, len(paires)))
        egal("au moins une fille", S["pau"], sp.Rational(au_moins_une_f, len(paires)))
        affiche(0, env["p2f"]); affiche(1, env["pfg"]); affiche(2, env["pau"])
    elif gid == "moyenne-ponderee-bulletin":
        coefs = [S["cm"], S["cf"], S["ca"], S["cs"]]
        notes = [S["nm"], S["nf"], S["na"], S["ns"]]
        pts = sum(c * n for c, n in zip(coefs, notes, strict=True))
        egal("somme des coefficients", S["coefs"], sum(coefs))
        egal("total pondéré", S["pts"], pts)
        egal("moyenne", S["moy"], pts / sum(coefs))
        affiche(1, g._decimal(env["pts"])); affiche(2, g._dec(env["moy"], Fraction(2)), "reponse")
        if inst["corrections"][3]["reponse"].startswith("Oui") != (pts / sum(coefs) >= 10):
            erreurs.append("verdict « la moyenne atteint 10 » faux")
    elif gid == "facture-electricite-energie":
        egal("énergie par jour (kWh)", S["ej"], S["pw"] * S["h"] / 1000)
        egal("énergie sur 30 jours", S["em"], 30 * S["pw"] * S["h"] / 1000)
        egal("coût", S["cout"], 30 * S["pw"] * S["h"] / 1000 * S["tarif"])
        affiche(0, g._decimal(env["ej"])); affiche(2, g._milliers_tex(env["cout"]))
    elif gid == "solution-nacl-concentration-dilution":
        M = sp.Rational(117, 2)
        egal("masse dissoute", S["m"], S["k"] * M)
        egal("concentration", S["c"], S["k"] / (S["v"] / 1000))
        egal("concentration après dilution", S["cf"], S["c"] * S["v0"] / S["v1"])
        egal("conservation de la quantité de matière", S["c"] * S["v0"] / 1000, S["cf"] * S["v1"] / 1000)
        affiche(0, g._decimal(env["m"])); affiche(1, g._decimal(env["c"])); affiche(2, g._decimal(env["cf"]))
    elif gid == "chute-libre-puits":
        tt = sp.symbols("tt")
        egal("vitesse", S["v"], sp.integrate(10, (tt, 0, S["t"])))
        egal("profondeur", S["h"], sp.integrate(10 * tt, (tt, 0, S["t"])))
        egal("vitesse en km/h", S["vk"], S["v"] * sp.Rational(3600, 1000))
        affiche(0, g._decimal(env["v"])); affiche(1, g._decimal(env["h"])); affiche(2, g._decimal(env["vk"]))
    else:
        erreurs.append("aucune vérification indépendante n'existe pour ce gabarit")
    return erreurs


def verifier_tous(nb_graines: int = 100) -> dict[str, list[str]]:
    from app.core import gabarits as g

    valides, invalides = g.charger_dossier()
    resultat = {nom: [f"fichier invalide : {msg}"] for nom, msg in invalides.items()}
    for gid, gab in valides.items():
        for graine in range(nb_graines):
            erreurs = verifier(gab, graine)
            if erreurs:
                resultat[gid] = [f"graine {graine} : {e}" for e in erreurs]
                break
        else:
            resultat[gid] = []
    return resultat


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    res = verifier_tous(n)
    for gid, erreurs in res.items():
        print(("✓" if not erreurs else "✗"), gid, *(f"\n    {e}" for e in erreurs[:3]))
    sys.exit(1 if any(res.values()) else 0)
