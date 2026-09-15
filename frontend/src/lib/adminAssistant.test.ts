import { describe, expect, it } from "vitest";
import {
  buildAdminAskPayload,
  extraireModifications,
  nettoyerHistorique,
  resumeEpreuveName,
} from "./adminAssistant";

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

describe("extraireModifications", () => {
  it("extrait le bloc sujet seul", () => {
    const reponse = [
      "Voici le sujet réécrit :",
      "```modification-sujet",
      "# Sujet corrigé",
      "",
      "Texte complété.",
      "```",
    ].join("\n");
    expect(extraireModifications(reponse)).toEqual({ sujet: "# Sujet corrigé\n\nTexte complété." });
  });

  it("extrait le bloc corrigé seul", () => {
    const reponse =
      "```modification-corrige\nLe corrigé complet révisé.  \n```\n";
    expect(extraireModifications(reponse)).toEqual({ corrige: "Le corrigé complet révisé." });
  });

  it("extrait les deux blocs dans une même réponse", () => {
    const reponse = [
      "Je vous propose les deux versions révisées.",
      "```modification-sujet",
      "Sujet revu.",
      "```",
      "```modification-corrige",
      "Corrigé revu.",
      "```",
    ].join("\n");
    expect(extraireModifications(reponse)).toEqual({ sujet: "Sujet revu.", corrige: "Corrigé revu." });
  });

  it("renvoie un objet vide sans aucun bloc", () => {
    expect(extraireModifications("La question 2 est claire, rien à corriger.")).toEqual({});
    expect(extraireModifications("")).toEqual({});
  });

  it("tolère une clôture de bloc manquante (raccourci de stream)", () => {
    const reponse = "```modification-sujet\nContenu sans fermeture.";
    expect(extraireModifications(reponse)).toEqual({ sujet: "Contenu sans fermeture." });
  });

  it("ne confond pas un bloc de code Markdown ordinaire avec une modification", () => {
    const reponse = "```python\nprint('hello')\n```";
    expect(extraireModifications(reponse)).toEqual({});
  });
});