import { describe, expect, it } from "vitest";
import { extraireActions } from "./adminActions";

describe("extraireActions", () => {
  it("extrait l'action et retire le bloc du texte", () => {
    const r = extraireActions('Je baisse le prix.\n```action\n{"outil":"plan_modifier","args":{"id":"p1","prix":700}}\n```\nOK ?');
    expect(r.actions).toEqual([{ outil: "plan_modifier", args: { id: "p1", prix: 700 } }]);
    expect(r.texte).toBe("Je baisse le prix.\n\nOK ?");
  });
  it("accepte une action sans arguments", () => {
    expect(extraireActions('```action\n{"outil":"sauvegarde_lancer"}\n```').actions).toEqual([{ outil: "sauvegarde_lancer", args: {} }]);
  });
  it("ignore un JSON invalide ou mal formé sans planter", () => {
    expect(extraireActions("```action\n{pas du json}\n```").actions).toEqual([]);
    expect(extraireActions('```action\n{"args":{}}\n```').actions).toEqual([]);
    expect(extraireActions('```action\n{"outil":"x","args":[1]}\n```').actions).toEqual([]);
  });
  it("laisse intacts les autres blocs de code", () => {
    const r = extraireActions("```json\n{\"a\":1}\n```");
    expect(r.actions).toEqual([]);
    expect(r.texte).toContain("```json");
  });
  it("gère plusieurs actions dans une même réponse", () => {
    const r = extraireActions('```action\n{"outil":"a","args":{}}\n```\n```action\n{"outil":"b","args":{}}\n```');
    expect(r.actions.map((a) => a.outil)).toEqual(["a", "b"]);
  });
});
