import { describe, expect, it } from "vitest";
import {
  chargerExtensions,
  GROUPES_OUTILS,
  KATEX_OPTIONS,
  normaliserPourRendu,
  verifierFormule,
} from "./renduMath";

describe("configuration KaTeX partagée", () => {
  it("garde le rendu tolérant et sûr en production", () => {
    expect(KATEX_OPTIONS.strict).toBe("ignore");
    expect(KATEX_OPTIONS.trust).toBe(false);
    expect(KATEX_OPTIONS.output).toBe("htmlAndMathml");
  });

  it("délègue la normalisation selon le contexte", () => {
    const source = "Résultat \\[x^2\\] fini.";
    const normalise = normaliserPourRendu(source, { preserverOffsets: false });
    expect(normalise).toContain("$$");
    expect(normalise).toContain("x^2");
    // Variante « offsets » : ne convertit que les délimiteurs seuls sur leur ligne.
    expect(normaliserPourRendu(source, { preserverOffsets: true })).toBe(source);
  });
});

describe("barre d'outils", () => {
  it("couvre les quatre domaines annoncés", () => {
    expect(GROUPES_OUTILS.map((g) => g.nom)).toEqual(["Maths", "Physique", "Chimie", "Structures"]);
    expect(GROUPES_OUTILS[0].outils.length).toBeGreaterThan(25);
    expect(GROUPES_OUTILS[2].outils.some((o) => o.extrait.includes("\\ce{"))).toBe(true);
    expect(GROUPES_OUTILS[3].outils.every((o) => o.extrait.includes("```mol"))).toBe(true);
  });

  it("chaque outil sélectionne une portion existante de son extrait", () => {
    for (const groupe of GROUPES_OUTILS) {
      for (const outil of groupe.outils) {
        expect(outil.debut).toBeGreaterThanOrEqual(0);
        expect(outil.fin).toBeGreaterThanOrEqual(outil.debut);
        expect(outil.fin).toBeLessThanOrEqual(outil.extrait.length);
        expect(outil.extrait).not.toContain("§");
      }
    }
  });

  it("le modèle de fraction place le curseur sur le numérateur", () => {
    const fraction = GROUPES_OUTILS[0].outils.find((o) => o.titre === "Fraction");
    expect(fraction?.extrait).toBe("$\\frac{a}{b}$");
    expect(fraction?.extrait.slice(fraction.debut, fraction.fin)).toBe("a");
  });
});

describe("extension mhchem (chargement différé)", () => {
  it("rend les formules chimiques après chargement, de façon idempotente", async () => {
    await Promise.all([chargerExtensions(), chargerExtensions()]);
    expect(() => verifierFormule("\\ce{H2O}", false)).not.toThrow();
    expect(() => verifierFormule("\\pu{123 kJ//mol}", false)).not.toThrow();
    expect(() => verifierFormule("\\ce{CO2 + C -> 2 CO}", true)).not.toThrow();
  });

  it("refuse toujours une commande inconnue", () => {
    expect(() => verifierFormule("\\commandeinconnue{x}", false)).toThrow();
  });
});
