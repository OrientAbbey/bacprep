import { describe, expect, it } from "vitest";
import { ONGLETS } from "../admin/onglets";
import { sectionsAideAdmin } from "./AideAdmin";
import { sectionsAideUtilisateur } from "./AideUtilisateur";

/** Aide de la console : en français pur (la console n'est pas traduite). */
describe("aide de la console d'administration", () => {
  it("sections non vides, identifiants uniques", () => {
    expect(sectionsAideAdmin.length).toBeGreaterThan(10);
    expect(new Set(sectionsAideAdmin.map((s) => s.id)).size).toBe(sectionsAideAdmin.length);
    for (const s of sectionsAideAdmin) {
      expect(s.titre.trim(), s.id).toBeTruthy();
      expect((s.points?.length ?? 0) + (s.intro ? 1 : 0), s.id).toBeGreaterThan(0);
    }
  });

  it("chaque onglet de la console est documenté", () => {
    const documentes = new Set(sectionsAideAdmin.map((s) => s.onglet).filter(Boolean));
    for (const o of ONGLETS) expect(documentes.has(o), `onglet « ${o} » sans rubrique d'aide`).toBe(true);
  });

  it("ne renvoie à aucun onglet inconnu", () => {
    for (const s of sectionsAideAdmin) if (s.onglet) expect(ONGLETS, s.id).toContain(s.onglet);
  });

  it("ne passe pas par la traduction (console en français uniquement)", () => {
    const texte = sectionsAideAdmin.flatMap((s) => [s.titre, s.intro ?? "", ...(s.points ?? []), s.astuce ?? ""]).join(" ");
    expect(texte).not.toMatch(/\bt\(/);
    expect(texte).toMatch(/console/);
  });
});

describe("aide des élèves", () => {
  it("sections non vides, identifiants uniques", () => {
    const sections = sectionsAideUtilisateur();
    expect(sections.length).toBeGreaterThan(5);
    expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length);
    for (const s of sections) {
      expect(s.titre.trim(), s.id).toBeTruthy();
      expect((s.points?.length ?? 0) + (s.intro ? 1 : 0), s.id).toBeGreaterThan(0);
    }
  });

  it("ne parle pas de la console d'administration", () => {
    const texte = sectionsAideUtilisateur()
      .flatMap((s) => [s.titre, s.intro ?? "", ...(s.points ?? []), s.astuce ?? ""])
      .join(" ")
      .toLowerCase();
    expect(texte).not.toMatch(/console|back-office|jeton admin/);
  });
});
