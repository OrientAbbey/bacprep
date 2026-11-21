import { describe, expect, it } from "vitest";
import { dureeEnMinutes, formaterDurée } from "./chronometre";

describe("dureeEnMinutes", () => {
  it("interprète les durées d'épreuve libres usuelles", () => {
    expect(dureeEnMinutes("4h")).toBe(240);
    expect(dureeEnMinutes("1h30")).toBe(90);
    expect(dureeEnMinutes("45 min")).toBe(45);
    expect(dureeEnMinutes("2 h 30")).toBe(150);
    expect(dureeEnMinutes("180")).toBe(180);
  });

  it("rejette les valeurs absentes, nulles et hors bornes", () => {
    expect(dureeEnMinutes(null)).toBeNull();
    expect(dureeEnMinutes("")).toBeNull();
    expect(dureeEnMinutes("0h")).toBeNull();
    expect(dureeEnMinutes("25h")).toBeNull();
    expect(dureeEnMinutes("illégal")).toBeNull();
  });

  it("ne confond pas heures et minutes", () => {
    expect(dureeEnMinutes("1h30")).toBe(90);
    expect(dureeEnMinutes("1h30min")).toBe(90);
    expect(dureeEnMinutes("30min")).toBe(30);
  });
});

describe("formaterDurée", () => {
  it("affiche MM:SS sans heure, HH:MM:SS au-delà", () => {
    expect(formaterDurée(0)).toBe("0:00");
    expect(formaterDurée(59)).toBe("0:59");
    expect(formaterDurée(90)).toBe("1:30");
    expect(formaterDurée(3600)).toBe("1:00:00");
    expect(formaterDurée(3661)).toBe("1:01:01");
  });

  it("borne les valeurs négatives à zéro", () => {
    expect(formaterDurée(-5)).toBe("0:00");
  });
});