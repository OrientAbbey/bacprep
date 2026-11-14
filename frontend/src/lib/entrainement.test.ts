import { describe, expect, it } from "vitest";
import {
  GRAINE_MAX,
  difficultesDe,
  filtrerExercices,
  formaterPoints,
  graineAleatoire,
  graineDepuisUrl,
  matieresDe,
  regrouper,
  type ResumeGabarit,
} from "./entrainement";

const ex = (id: string, matiere: string, chapitre: string, difficulte = 1): ResumeGabarit => ({ id, titre: id, matiere, classes: ["terminale"], chapitre, difficulte, total_points: 3 });

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

const listeFiltres = [
  ex("a", "Maths", "Suites", 1),
  ex("b", "Maths", "Limites", 2),
  ex("c", "Physique", "Électricité", 3),
  ex("d", "Maths", "Suites", 3),
];

describe("matieresDe", () => {
  it("déduplique les matières dans l'ordre d'arrivée", () => {
    expect(matieresDe(listeFiltres)).toEqual(["Maths", "Physique"]);
  });
  it("liste vide", () => expect(matieresDe([])).toEqual([]));
});

describe("difficultesDe", () => {
  it("déduplique et trie les difficultés croissantes", () => {
    expect(difficultesDe(listeFiltres)).toEqual([1, 2, 3]);
    expect(difficultesDe([ex("x", "Maths", "Suites", 3), ex("y", "Maths", "Suites", 1)])).toEqual([1, 3]);
  });
  it("liste vide", () => expect(difficultesDe([])).toEqual([]));
});

describe("filtrerExercices", () => {
  it("sans filtre (ou avec des valeurs vides) renvoie tout", () => {
    expect(filtrerExercices(listeFiltres)).toHaveLength(4);
    expect(filtrerExercices(listeFiltres, { matiere: "", difficulte: "" })).toHaveLength(4);
  });
  it("filtre par matière", () => {
    expect(filtrerExercices(listeFiltres, { matiere: "Maths" }).map((e) => e.id)).toEqual(["a", "b", "d"]);
  });
  it("filtre par difficulté, comparée en chaîne (valeur du sélecteur)", () => {
    expect(filtrerExercices(listeFiltres, { difficulte: "3" }).map((e) => e.id)).toEqual(["c", "d"]);
  });
  it("combine matière et difficulté", () => {
    expect(filtrerExercices(listeFiltres, { matiere: "Maths", difficulte: "2" }).map((e) => e.id)).toEqual(["b"]);
  });
  it("renvoie une liste vide quand rien ne correspond", () => {
    expect(filtrerExercices(listeFiltres, { matiere: "Physique", difficulte: "1" })).toEqual([]);
  });
});
