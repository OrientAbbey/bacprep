import { describe, expect, it } from "vitest";
import {
  appliquerEditions,
  appliquerPaires,
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

describe("modifications ciblées (chercher / remplacer) et numérotées", () => {
  const bloc = (verbe: string, corps: string, fence = "```") => `${fence}${verbe}\n${corps}\n${fence}`;

  it("extrait les paires et le numéro de sujet", () => {
    const m = extraireModifications(
      "Voici :\n" + bloc("remplacer-sujet:2", "<<<<<<< CHERCHER\nancien\n=======\nnouveau\n>>>>>>> REMPLACER\n<<<<<<< CHERCHER\na\n=======\nb\n>>>>>>> REMPLACER")
    );
    expect(m.editions).toEqual([{ cible: "sujet", numero: 2, paires: [{ chercher: "ancien", remplacer: "nouveau" }, { chercher: "a", remplacer: "b" }] }]);
    expect(m.sujet).toBeUndefined();
  });

  it("distingue la réécriture complète numérotée (editions) de la non numérotée (champ historique)", () => {
    const m = extraireModifications(bloc("modification-corrige:3", "Tout le corrigé") + "\n" + bloc("modification-sujet", "Tout le sujet"));
    expect(m.editions).toEqual([{ cible: "corrige", numero: 3, complet: "Tout le corrigé" }]);
    expect(m.sujet).toBe("Tout le sujet");
  });

  it("gère une partie CHERCHER vide (ajout) et une partie REMPLACER vide (suppression)", () => {
    const m = extraireModifications(bloc("remplacer-sujet", "<<<<<<< CHERCHER\n=======\nAjout final\n>>>>>>> REMPLACER\n<<<<<<< CHERCHER\nà supprimer\n=======\n>>>>>>> REMPLACER"));
    expect(m.editions?.[0].paires).toEqual([{ chercher: "", remplacer: "Ajout final" }, { chercher: "à supprimer", remplacer: "" }]);
  });

  it("accepte une clôture à 4 apostrophes inverses quand le contenu contient lui-même des ```", () => {
    const m = extraireModifications(bloc("modification-sujet:1", "Avant\n```python\nprint(1)\n```\nAprès", "````"));
    expect(m.editions?.[0].complet).toBe("Avant\n```python\nprint(1)\n```\nAprès");
  });

  it("ignore un remplacement sans paire valide", () => {
    expect(extraireModifications(bloc("remplacer-sujet", "n'importe quoi")).editions).toBeUndefined();
  });
});

describe("appliquerPaires", () => {
  it("remplace un extrait unique", () => {
    const r = appliquerPaires("a\nb\nc", [{ chercher: "b", remplacer: "B" }]);
    expect(r.texte).toBe("a\nB\nc");
    expect(r.resultats).toEqual([{ ok: true }]);
  });
  it("refuse un extrait introuvable ou ambigu sans toucher au texte", () => {
    expect(appliquerPaires("a b a", [{ chercher: "a", remplacer: "X" }])).toEqual({ texte: "a b a", resultats: [{ ok: false, raison: "ambigu" }] });
    expect(appliquerPaires("abc", [{ chercher: "zzz", remplacer: "X" }]).resultats).toEqual([{ ok: false, raison: "introuvable" }]);
  });
  it("tolère espaces de fin de ligne et fins de ligne Windows", () => {
    const r = appliquerPaires("Ligne 1   \r\nLigne 2\r\nLigne 3", [{ chercher: "Ligne 1\nLigne 2", remplacer: "Neuf" }]);
    expect(r.resultats).toEqual([{ ok: true }]);
    expect(r.texte).toBe("Neuf\nLigne 3");
  });
  it("ajoute à la fin avec un CHERCHER vide, et remplit un contenu vide", () => {
    expect(appliquerPaires("Début\n", [{ chercher: "", remplacer: "Fin" }]).texte).toBe("Début\n\nFin");
    expect(appliquerPaires("", [{ chercher: "", remplacer: "Premier" }]).texte).toBe("Premier");
  });
  it("applique les paires dans l'ordre (la suivante voit le résultat de la précédente)", () => {
    expect(appliquerPaires("un", [{ chercher: "un", remplacer: "deux" }, { chercher: "deux", remplacer: "trois" }]).texte).toBe("trois");
  });
  it("conserve les formules LaTeX et les ancres telles quelles", () => {
    const r = appliquerPaires("## Q1 {#q1}\n\n$$\nx^2\n$$\n", [{ chercher: "$$\nx^2\n$$", remplacer: "$$\nx^3\n$$" }]);
    expect(r.texte).toBe("## Q1 {#q1}\n\n$$\nx^3\n$$\n");
  });
});

describe("appliquerEditions", () => {
  const sujets = [
    { contenu_markdown: "S1 texte", corrige_markdown: "C1" },
    { contenu_markdown: "S2 texte", corrige_markdown: "" },
  ];
  it("vise le sujet numéroté, ou le sujet affiché par défaut, sans modifier l'original", () => {
    const r = appliquerEditions(sujets, [{ cible: "sujet", numero: 2, paires: [{ chercher: "texte", remplacer: "NEUF" }] }, { cible: "corrige", complet: "C1 bis" }], 1);
    expect(r.sujets[1].contenu_markdown).toBe("S2 NEUF");
    expect(r.sujets[0].corrige_markdown).toBe("C1 bis"); // pas de numéro : rang actif = 1
    expect(r.resultats.every((x) => x.ok)).toBe(true);
    expect(sujets[1].contenu_markdown).toBe("S2 texte"); // l'entrée n'est pas mutée
  });
  it("signale un sujet inexistant et un extrait introuvable (tout ou rien par édition)", () => {
    const r = appliquerEditions(sujets, [
      { cible: "sujet", numero: 9, complet: "x" },
      { cible: "sujet", numero: 1, paires: [{ chercher: "S1", remplacer: "OK" }, { chercher: "absent", remplacer: "KO" }] },
    ], 1);
    expect(r.resultats[0]).toMatchObject({ ok: false, raison: "le sujet 9 n'existe pas" });
    expect(r.resultats[1].ok).toBe(false);
    expect(r.sujets[0].contenu_markdown).toBe("S1 texte"); // la première paire valide n'a PAS été gardée
  });
});
