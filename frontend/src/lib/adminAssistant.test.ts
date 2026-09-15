import { describe, expect, it } from "vitest";
import { buildAdminAskPayload, nettoyerHistorique, resumeEpreuveName } from "./adminAssistant";

const FORM = {
  niveau: "SECONDAIRE",
  classe: "terminale",
  evaluation: "BAC",
  matiere: "Mathématiques",
  annee: "2024",
  session: "Session normale",
  duree: "4h",
  coefficient: "5",
  gratuit: true,
  statut: "brouillon",
  filieres: ["C", "D"],
  contenu_markdown: "# Sujet",
  corrige_markdown: "# Corrigé",
};

describe("buildAdminAskPayload", () => {
  it("n'envoie JAMAIS de conversation_id (échange éphémère)", () => {
    const payload = buildAdminAskPayload(FORM, [], "Une question");
    expect("conversation_id" in payload).toBe(false);
  });

  it("embarque l'instantané complet du formulaire", () => {
    const payload = buildAdminAskPayload(FORM, [], "Q");
    expect(payload.epreuve).toEqual({
      niveau: "SECONDAIRE",
      classe: "terminale",
      evaluation: "BAC",
      matiere: "Mathématiques",
      annee: "2024",
      session: "Session normale",
      duree: "4h",
      coefficient: "5",
      gratuit: true,
      statut: "brouillon",
      filieres: ["C", "D"],
      contenu_markdown: "# Sujet",
      corrige_markdown: "# Corrigé",
    });
  });

  it("reporte la question de l'admin", () => {
    const payload = buildAdminAskPayload(FORM, [], "Reprends l'exercice 2.");
    expect(payload.question).toBe("Reprends l'exercice 2.");
  });

  it("purge l'historique des messages vides (bulle assistant en streaming)", () => {
    const historique = [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "R1" },
      { role: "user", content: "Q2" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "   " },
    ];
    const payload = buildAdminAskPayload(FORM, historique, "Q3");
    expect(payload.historique).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "R1" },
      { role: "user", content: "Q2" },
    ]);
  });
});

describe("nettoyerHistorique", () => {
  it("écarte les messages vides ou réduits à des espaces", () => {
    expect(
      nettoyerHistorique([
        { role: "user", content: "" },
        { role: "assistant", content: "  " },
        { role: "user", content: " ok " },
      ])
    ).toEqual([{ role: "user", content: " ok " }]);
  });

  it("laisse un historique vide intact", () => {
    expect(nettoyerHistorique([])).toEqual([]);
  });
});

describe("resumeEpreuveName", () => {
  it("assemble matière · année · classe · évaluation", () => {
    expect(resumeEpreuveName(FORM)).toBe("Mathématiques · 2024 · terminale · BAC");
  });

  it("ignore les champs manquants", () => {
    expect(
      resumeEpreuveName({ ...FORM, matiere: "", annee: "" })
    ).toBe("terminale · BAC");
  });

  it("retombe sur un libellé générique sans aucun champ rempli", () => {
    expect(
      resumeEpreuveName({ ...FORM, matiere: "", annee: "", classe: "", evaluation: "" })
    ).toBe("épreuve en cours");
  });
});