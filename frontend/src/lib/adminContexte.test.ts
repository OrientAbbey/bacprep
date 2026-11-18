import { describe, expect, it } from "vitest";
import {
  appliquerChampsAdmin,
  appliquerEditionsAdmin,
  effacerContexteAdmin,
  enregistrerAppliqueurAdmin,
  enregistrerOuvreurAdmin,
  lireContexteAdmin,
  ouvrirFormulaireAdmin,
  publierContexteAdmin,
} from "./adminContexte";

describe("contexte partagé admin", () => {
  it("garde l'ouvreur et l'appliqueur quand le contexte est republié", () => {
    effacerContexteAdmin("banque-test");
    let ouvert = "";
    const champs: Record<string, unknown>[] = [];
    enregistrerOuvreurAdmin("banque-test", (cible) => { ouvert = cible; return cible === "exercice"; });
    enregistrerAppliqueurAdmin("banque-test", (editions) => champs.push(...editions));
    publierContexteAdmin("banque-test", { formulaire: { sujet: "" } });

    expect(ouvrirFormulaireAdmin("banque-test", "exercice")).toBe(true);
    expect(ouvrirFormulaireAdmin("banque-test", "inconnu")).toBe(false);
    expect(ouvert).toBe("inconnu");
    expect(appliquerEditionsAdmin("banque-test", [{ champs: { sujet: "S" } }])).toBe(true);
    expect(champs).toEqual([{ champs: { sujet: "S" } }]);
    expect(lireContexteAdmin("banque-test")?.formulaire).toEqual({ sujet: "" });
    champs.length = 0;
    expect(appliquerChampsAdmin("banque-test", [{ sujet: "Brut" }])).toBe(true);
    expect(champs).toEqual([{ champs: { sujet: "Brut" } }]);
    effacerContexteAdmin("banque-test");
  });
});
