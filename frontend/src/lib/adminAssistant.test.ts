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
  duree: "4h",
  coefficient: "5",
  gratuit: true,
  statut: "brouillon",
  filieres: ["C", "D"],
  // Multi-sujets : le sujet principal est l'index 0 — saisi à plat par
  // l'assistant (`contenu_markdown`/`corrige_markdown`), sans information
  // sur les sujets supplémentaires.
  sujets: [
    { index: 0, contenu_markdown: "# Sujet", corrige_markdown: "# Corrigé" },
    { index: 1, contenu_markdown: "# Sujet 2", corrige_markdown: "" },
  ],
};

describe("buildAdminAskPayload", () => {
  it("n'envoie JAMAIS de conversation_id ; `epreuve_id` absent par défaut (échange éphémère)", () => {
    const payload = buildAdminAskPayload(FORM, [], "Une question");
    expect("conversation_id" in payload).toBe(false);
    expect("epreuve_id" in payload).toBe(false);
  });

  it("embarque `epreuve_id` quand fourni (échange persisté)", () => {
    const payload = buildAdminAskPayload(FORM, [], "Une question", "epr-123");
    expect(payload.epreuve_id).toBe("epr-123");
  });

  it("embarque l'instantané complet du formulaire (sujet principal à plat + sujets)", () => {
    const payload = buildAdminAskPayload(FORM, [], "Q");
    expect(payload.epreuve).toEqual({
      niveau: "SECONDAIRE",
      classe: "terminale",
      evaluation: "BAC",
      matiere: "Mathématiques",
      annee: "2024",
      duree: "4h",
      coefficient: "5",
      gratuit: true,
      statut: "brouillon",
      filieres: ["C", "D"],
      contenu_markdown: "# Sujet",
      corrige_markdown: "# Corrigé",
      sujets: FORM.sujets,
    });
  });

  it("expose le sujet principal à plat même quand l'index 0 est absent", () => {
    const payload = buildAdminAskPayload({ ...FORM, sujets: [FORM.sujets[1]] }, [], "Q");
    expect(payload.epreuve.contenu_markdown).toBe("# Sujet 2");
    expect(payload.epreuve.corrige_markdown).toBe("");
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

  it("extrait les métadonnées du bloc `modification-form` (JSON)", () => {
    const reponse = [
      "Voici les métadonnées à corriger :",
      "```modification-form",
      '{"matiere": "SVT", "annee": "2025", "duree": 180, "gratuit": false, "statut": "a_reviser", "filieres": ["C", "D"]}',
      "```",
    ].join("\n");
    expect(extraireModifications(reponse)).toEqual({
      form: { matiere: "SVT", annee: "2025", duree: 180, gratuit: false, statut: "a_reviser", filieres: ["C", "D"] },
    });
  });

  it("ignore un bloc `modification-form` au JSON invalide", () => {
    const reponse = "```modification-form\n{pas du json}\n```";
    expect(extraireModifications(reponse)).toEqual({});
  });

  it("combine sujet, corrigé et formulaire dans une même réponse", () => {
    const reponse = [
      "```modification-sujet",
      "Sujet revu.",
      "```",
      "```modification-corrige",
      "Corrigé revu.",
      "```",
      "```modification-form",
      '{"annee": "2023"}',
      "```",
    ].join("\n");
    expect(extraireModifications(reponse)).toEqual({
      sujet: "Sujet revu.",
      corrige: "Corrigé revu.",
      form: { annee: "2023" },
    });
  });
});