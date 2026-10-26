import { afterEach, describe, expect, it, vi } from "vitest";
import { assemblerContenu, contenuAffiche, affichageInitial, immersionInitiale, memoriserAffichage, memoriserImmersion } from "./sujets";

const sujets = [
  { contenu_markdown: "Premier énoncé", corrige_markdown: "Solution 1" },
  { contenu_markdown: "  Deuxième énoncé  ", corrige_markdown: "" },
  { contenu_markdown: "", corrige_markdown: "Solution 3" },
];

describe("assemblerContenu", () => {
  it("met les sujets bout à bout avec un titre numéroté et un séparateur, en ignorant les parties vides", () => {
    expect(assemblerContenu(sujets, "sujet")).toBe("## Sujet 1\n\nPremier énoncé\n\n---\n\n## Sujet 2\n\nDeuxième énoncé");
  });
  it("garde la numérotation d'origine pour les corrigés (un corrigé absent ne décale pas les numéros)", () => {
    expect(assemblerContenu(sujets, "corrige")).toBe("## Corrigé du sujet 1\n\nSolution 1\n\n---\n\n## Corrigé du sujet 3\n\nSolution 3");
  });
  it("renvoie une chaîne vide quand rien n'est à afficher", () => {
    expect(assemblerContenu([], "sujet")).toBe("");
    expect(assemblerContenu([{ contenu_markdown: "", corrige_markdown: "" }], "corrige")).toBe("");
  });
});

describe("contenuAffiche", () => {
  it("« page » : uniquement le sujet actif", () => {
    expect(contenuAffiche(sujets, sujets[1], "sujet", "page")).toBe("  Deuxième énoncé  ");
    expect(contenuAffiche(sujets, undefined, "corrige", "page")).toBe("");
  });
  it("« tout » : tous les sujets, mais pas pour un sujet unique (inchangé)", () => {
    expect(contenuAffiche(sujets, sujets[0], "sujet", "tout")).toContain("## Sujet 2");
    expect(contenuAffiche([sujets[0]], sujets[0], "sujet", "tout")).toBe("Premier énoncé");
  });
});

describe("préférence d'affichage", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("est mémorisée et vaut « page » par défaut, même sans stockage", () => {
    const m: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => m[k] ?? null, setItem: (k: string, v: string) => void (m[k] = v) });
    expect(affichageInitial()).toBe("page");
    memoriserAffichage("tout");
    expect(affichageInitial()).toBe("tout");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("bloqué"); }, setItem: () => { throw new Error("bloqué"); } });
    expect(affichageInitial()).toBe("page");
    expect(() => memoriserAffichage("tout")).not.toThrow();
  });
});

describe("préférence d'immersion", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("est désactivée par défaut, mémorisée, et reste désactivée sans stockage", () => {
    const m: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => m[k] ?? null, setItem: (k: string, v: string) => void (m[k] = v) });
    expect(immersionInitiale()).toBe(false);
    memoriserImmersion(true);
    expect(immersionInitiale()).toBe(true);
    memoriserImmersion(false);
    expect(immersionInitiale()).toBe(false);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("bloqué"); }, setItem: () => { throw new Error("bloqué"); } });
    expect(immersionInitiale()).toBe(false);
    expect(() => memoriserImmersion(true)).not.toThrow();
  });
});
