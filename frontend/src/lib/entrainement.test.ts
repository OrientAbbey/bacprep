import { describe, expect, it } from "vitest";
import { GRAINE_MAX, formaterPoints, graineAleatoire, graineDepuisUrl, regrouper, type ResumeGabarit } from "./entrainement";

const ex = (id: string, matiere: string, chapitre: string): ResumeGabarit => ({ id, titre: id, matiere, classes: ["terminale"], chapitre, difficulte: 1, total_points: 3 });

describe("graineDepuisUrl", () => {
  it("accepte un entier décimal valide", () => {
    expect(graineDepuisUrl("0")).toBe(0);
    expect(graineDepuisUrl("123456")).toBe(123456);
    expect(graineDepuisUrl(String(GRAINE_MAX))).toBe(GRAINE_MAX);
  });
  it("refuse tout le reste : le serveur tirera une graine", () => {
    for (const mauvais of [null, "", "-1", "1.5", "abc", "1e3", " 12", "12 ", String(GRAINE_MAX + 1), "99999999999", "0x10"]) expect(graineDepuisUrl(mauvais)).toBeNull();
  });
});

describe("graineAleatoire", () => {
  it("reste dans l'intervalle accepté par le serveur et varie", () => {
    const tirages = Array.from({ length: 200 }, graineAleatoire);
    expect(tirages.every((g) => Number.isInteger(g) && g >= 0 && g <= GRAINE_MAX)).toBe(true);
    expect(new Set(tirages).size).toBeGreaterThan(150);
  });
});

describe("formaterPoints", () => {
  it("met la virgule en français et le point en anglais", () => {
    expect(formaterPoints(1.5, "fr")).toBe("1,5");
    expect(formaterPoints(1.5, "en")).toBe("1.5");
    expect(formaterPoints(2, "fr")).toBe("2");
    expect(formaterPoints(0.25, "fr")).toBe("0,25");
    expect(formaterPoints(3.75, "en")).toBe("3.75");
  });
});

describe("regrouper", () => {
  it("regroupe par matière puis par chapitre en gardant l'ordre", () => {
    const g = regrouper([ex("a", "Maths", "Suites"), ex("b", "Maths", "Suites"), ex("c", "Maths", "Limites"), ex("d", "Physique", "Électricité")]);
    expect(g.map((m) => m.matiere)).toEqual(["Maths", "Physique"]);
    expect(g[0].chapitres.map((c) => [c.chapitre, c.exercices.map((e) => e.id)])).toEqual([["Suites", ["a", "b"]], ["Limites", ["c"]]]);
  });
  it("liste vide", () => expect(regrouper([])).toEqual([]));
});
