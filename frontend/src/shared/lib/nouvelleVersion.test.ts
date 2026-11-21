import { describe, expect, it } from "vitest";
import { DELAI_ANTI_BOUCLE_MS, doitRecharger, estChunkPerime } from "./nouvelleVersion";

describe("estChunkPerime", () => {
  it("reconnaît l'échec d'import d'un chunk supprimé par un déploiement", () => {
    expect(estChunkPerime(new TypeError("Failed to fetch dynamically imported module: https://x/assets/AdminPage-CDnaR6mQ.js"))).toBe(true);
    expect(estChunkPerime(new Error("error loading dynamically imported module"))).toBe(true);
    expect(estChunkPerime("Importing a module script failed.")).toBe(true);
  });
  it("ne confond pas une vraie erreur de rendu avec un chunk périmé", () => {
    expect(estChunkPerime(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(estChunkPerime(null)).toBe(false);
    expect(estChunkPerime(undefined)).toBe(false);
  });
});

describe("doitRecharger", () => {
  it("autorise le premier rechargement", () => {
    expect(doitRecharger(0, 1_000_000)).toBe(true);
  });
  it("bloque les rechargements rapprochés (anti-boucle)", () => {
    expect(doitRecharger(1_000_000, 1_000_000 + DELAI_ANTI_BOUCLE_MS - 1)).toBe(false);
  });
  it("réautorise après la fenêtre", () => {
    expect(doitRecharger(1_000_000, 1_000_000 + DELAI_ANTI_BOUCLE_MS)).toBe(true);
  });
});
