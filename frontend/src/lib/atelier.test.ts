import { describe, expect, it } from "vitest";
import { ajouterALaSuite, extraireFormules, verifierFormules } from "./atelier";

describe("extraireFormules", () => {
  it("trouve les formules en ligne et en bloc", () => {
    const f = extraireFormules("Soit $x^2$ puis $$\\frac{a}{b}$$ et $y$.");
    expect(f).toEqual([
      { formule: "\\frac{a}{b}", bloc: true },
      { formule: "x^2", bloc: false },
      { formule: "y", bloc: false },
    ]);
  });

  it("ignore le dollar échappé (prix, devise)", () => {
    expect(extraireFormules("Un article à 5 \\$ et un autre à 7 \\$.")).toEqual([]);
  });

  it("ne confond pas deux blocs consécutifs avec des formules en ligne", () => {
    const f = extraireFormules("$$a$$\n\n$$b$$");
    expect(f.map((x) => x.formule)).toEqual(["a", "b"]);
    expect(f.every((x) => x.bloc)).toBe(true);
  });

  it("une formule en ligne ne s'étend pas sur plusieurs lignes", () => {
    expect(extraireFormules("$a\nb$")).toEqual([]);
  });
});

describe("verifierFormules", () => {
  it("ne signale rien pour des formules valides", () => {
    expect(verifierFormules("Soit $f(x) = x^2 - 3x + 1$ et $$\\int_0^1 f(t)\\,dt = \\left[\\frac{t^3}{3}\\right]_0^1$$", "sujet")).toEqual([]);
  });

  it("signale une formule qui ne compile pas, avec sa provenance", () => {
    const c = verifierFormules("Voir $\\frac{1}{$ ici.", "corrige");
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ niveau: "erreur", code: "formule_invalide", params: { ou: "corrige" } });
    expect(String(c[0].params.message).length).toBeGreaterThan(0);
    expect(String(c[0].params.message)).not.toMatch(/^KaTeX parse error/i);
  });

  it("signale une commande inconnue", () => {
    expect(verifierFormules("$\\commandeinconnue{x}$", "sujet")).toHaveLength(1);
  });

  it("détaille au plus cinq formules", () => {
    const md = Array.from({ length: 9 }, (_, i) => `$\\frac{${i}}{$`).join(" ");
    expect(verifierFormules(md, "sujet").length).toBe(5);
  });

  it("accepte les environnements usuels du secondaire", () => {
    expect(verifierFormules("$$\\begin{cases} x+y=1 \\\\ x-y=0 \\end{cases}$$ et $\\vec{AB}\\cdot\\vec{AC}$ et $\\lim_{x\\to+\\infty}\\frac{1}{x}=0$", "sujet")).toEqual([]);
  });
});

describe("ajouterALaSuite", () => {
  it("remplace un texte vide", () => {
    expect(ajouterALaSuite("", "## A\n")).toBe("## A\n");
    expect(ajouterALaSuite("  \n\n", "## A")).toBe("## A\n");
  });

  it("ajoute après une ligne vide, sans empiler les retours à la ligne", () => {
    expect(ajouterALaSuite("# Sujet\n\nQuestion 1\n\n\n", "## B\n")).toBe("# Sujet\n\nQuestion 1\n\n## B\n");
  });
});
