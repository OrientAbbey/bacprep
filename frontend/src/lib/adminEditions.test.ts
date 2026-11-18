import { describe, expect, it } from "vitest";
import { extraireEditions, fusionnerEditions } from "./adminEditions";
import type { ChampAdmin } from "./adminContexte";

const CHAMPS: ChampAdmin[] = [
  { cle: "libelle", libelle: "Libellé" },
  { cle: "prix", libelle: "Prix", type: "number" },
  { cle: "actif", libelle: "Actif", type: "boolean" },
];

describe("extraireEditions", () => {
  it("sépare le texte des éditions et accepte les clés préfixées", () => {
    const r = extraireEditions(
      'Je remplis le formulaire.\n```edition {"champs": {"formulaire.libelle": "Trimestriel", "prix": "900", "actif": "oui"}}```\nFin.',
      CHAMPS,
    );
    expect(r.texte).toContain("Je remplis le formulaire.");
    expect(r.texte).toContain("Fin.");
    expect(r.texte).not.toContain("```");
    expect(r.editions).toEqual([{ champs: { libelle: "Trimestriel", prix: "900", actif: "oui" } }]);
  });

  it("ignore les clés non déclarées et les blocs invalides", () => {
    const r = extraireEditions(
      '```edition {"champs": {"inconnu": "x", "libelle": "OK"}}```\n```edition {pas json}```',
      CHAMPS,
    );
    expect(r.editions).toEqual([{ champs: { libelle: "OK" } }]);
  });

  it("accepte toutes les clés si aucun schéma n'est fourni", () => {
    const r = extraireEditions('```edition {"champs": {"a": 1}}```');
    expect(r.editions).toEqual([{ champs: { a: 1 } }]);
  });
});

describe("fusionnerEditions", () => {
  it("respecte les types déclarés", () => {
    const f = fusionnerEditions(
      { libelle: "Mensuel", prix: 100, actif: false },
      [{ champs: { libelle: "Annuel", prix: "2500", actif: "true" } }],
      CHAMPS,
    );
    expect(f).toEqual({ libelle: "Annuel", prix: 2500, actif: true });
  });
});
