import { describe, expect, it } from "vitest";
import { dateLongue, heureCourte } from "./dates";

/** Date construite en heure LOCALE pour éviter toute dépendance au fuseau
 * de la machine qui lance les tests. */
function isoLocal(y: number, mo: number, d: number, h: number, mi: number): string {
  return new Date(y, mo - 1, d, h, mi).toISOString();
}

describe("heureCourte — timestamps des messages assistant", () => {
  it("formate une date ISO en HH:MM", () => {
    expect(heureCourte(isoLocal(2026, 9, 15, 14, 5))).toBe("14:05");
    expect(heureCourte(isoLocal(2026, 9, 15, 9, 30))).toBe("09:30");
  });

  it("renvoie null sans horodatage", () => {
    expect(heureCourte(undefined)).toBeNull();
    expect(heureCourte(null)).toBeNull();
    expect(heureCourte("pas-une-date")).toBeNull();
  });
});

describe("dateLongue — date complète au survol", () => {
  it("renvoie une chaîne lisible pour une date valide", () => {
    const d = dateLongue(isoLocal(2026, 9, 15, 14, 5));
    expect(d).toBeTruthy();
    expect(d).toContain("2026");
  });

  it("renvoie null sans horodatage", () => {
    expect(dateLongue(undefined)).toBeNull();
    expect(dateLongue("")).toBeNull();
  });
});