import { describe, expect, it } from "vitest";
import type { Evenement } from "../api/types";
import { joursAvant, prochainExamen } from "./calendrier";

const ev = (id: string, type: Evenement["type"], debut: string, fin = ""): Evenement => ({
  id, titre: id, type, evaluation: "", date_debut: debut, date_fin: fin, lien_officiel: "", visible: true,
});

describe("calendrier", () => {
  const auj = new Date(2026, 9, 4, 15, 30); // 4 octobre 2026, milieu d'après-midi
  it("compte les jours calendaires, indépendamment de l'heure", () => {
    expect(joursAvant("2026-10-04", auj)).toBe(0);
    expect(joursAvant("2026-10-05", auj)).toBe(1);
    expect(joursAvant("2026-10-03", auj)).toBe(-1);
    expect(joursAvant("2027-06-01", auj)).toBe(240);
  });
  it("retient le prochain examen, ignore résultats et passés, garde un examen en cours", () => {
    const l = [ev("passe", "examen", "2026-06-01"), ev("res", "resultats", "2026-10-10"), ev("lointain", "examen", "2027-06-10"),
      ev("proche", "examen", "2027-03-01"), ev("encours", "examen", "2026-10-01", "2026-10-06")];
    expect(prochainExamen(l, auj)?.id).toBe("encours");
    expect(prochainExamen(l.filter((e) => e.id !== "encours"), auj)?.id).toBe("proche");
    expect(prochainExamen([ev("passe", "examen", "2026-06-01")], auj)).toBeNull();
  });
});
