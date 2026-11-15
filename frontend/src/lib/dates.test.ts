import { describe, expect, it } from "vitest";
import { dateLongue, horodatageCourt } from "./dates";

/** Date construite en heure LOCALE pour éviter toute dépendance au fuseau
 * de la machine qui lance les tests. */
function isoLocal(y: number, mo: number, d: number, h: number, mi: number): string {
  return new Date(y, mo - 1, d, h, mi).toISOString();
}

describe("horodatageCourt — timestamps des messages assistant", () => {
  it("formate une date ISO en date + heure (l'heure seule ne suffit pas)", () => {
    const a = horodatageCourt(isoLocal(2026, 9, 15, 14, 5));
    expect(a).toContain("2026");
    expect(a).toContain("14:05");
    // Deux jours différents ne donnent pas le même libellé.
    expect(horodatageCourt(isoLocal(2026, 9, 16, 14, 5))).not.toBe(a);
  });

  it("renvoie null sans horodatage", () => {
    expect(horodatageCourt(undefined)).toBeNull();
    expect(horodatageCourt(null)).toBeNull();
    expect(horodatageCourt("pas-une-date")).toBeNull();
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
