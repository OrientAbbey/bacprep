import { describe, expect, it } from "vitest";
import {
  ecritureAutorisee,
  empreinteCourte,
  essaiConcerne,
  nombreAnomalies,
  pourcentage,
} from "./sauvegardes";

describe("nombreAnomalies", () => {
  it("compte les quatre familles d'anomalie", () => {
    expect(
      nombreAnomalies({
        introuvables: ["a", "b"],
        incoherences: ["c"],
        corrompues: ["d"],
        erreurs: ["e", "f"],
      })
    ).toBe(6);
  });

  it("vaut 0 pour un rapport vide, absent ou sans anomalie", () => {
    expect(nombreAnomalies({})).toBe(0);
    expect(nombreAnomalies(null)).toBe(0);
    expect(nombreAnomalies(undefined)).toBe(0);
    // Un rapport d'export n'a aucune de ces clés : il n'est pas « sain », il
    // est simplement d'une autre nature.
    expect(nombreAnomalies({ epreuve_count: 12, fichier_count: 40 })).toBe(0);
  });

  it("compte `erreurs` comme une anomalie", () => {
    // Régression : une partie abandonnée pour structure ambiguë ne produit
    // AUCUN fichier introuvable, mais la restauration a pourtant laissé des
    // fichiers de côté. Si `erreurs` ne comptait pas, l'écriture serait
    // proposée sur une restauration incomplète.
    expect(nombreAnomalies({ erreurs: [{ partie: "part-0001.zip" }] })).toBe(1);
  });
});

describe("ecritureAutorisee", () => {
  const essaiSain = { dry_run: true, epreuves: 3, ecrits: 12 };

  it("autorise l'écriture après un essai à blanc sans anomalie", () => {
    expect(ecritureAutorisee(essaiSain, "done")).toBe(true);
  });

  it("refuse si le job a échoué, même sans anomalie listée", () => {
    // Un job `error` signifie que les métadonnées n'ont PAS été écrites :
    // relancer une écriture dessus sans relire le rapport serait une faute.
    expect(ecritureAutorisee(essaiSain, "error")).toBe(false);
    expect(ecritureAutorisee(essaiSain, "running")).toBe(false);
    expect(ecritureAutorisee(essaiSain, "pending")).toBe(false);
  });

  it("refuse si le rapport n'était pas un essai à blanc", () => {
    // Un rapport d'export a `epreuve_count`, pas `dry_run` : proposer
    // « restaurer » dessus afficherait des compteurs sans rapport.
    expect(ecritureAutorisee({ epreuve_count: 3, fichier_count: 12 }, "done")).toBe(false);
    // `dry_run` explicitement faux = une écriture déjà faite.
    expect(ecritureAutorisee({ dry_run: false, ecrits: 12 }, "done")).toBe(false);
  });

  it("refuse dès qu'une seule anomalie est présente", () => {
    for (const cle of ["introuvables", "incoherences", "corrompues", "erreurs"] as const) {
      expect(ecritureAutorisee({ ...essaiSain, [cle]: ["x"] }, "done")).toBe(false);
    }
  });

  it("refuse sans rapport", () => {
    // Défaut fail-safe : un bouton d'écriture ne doit JAMAIS être disponible
    // tant qu'aucun rapport n'a été lu.
    expect(ecritureAutorisee(null, "done")).toBe(false);
    expect(ecritureAutorisee(undefined, "done")).toBe(false);
  });
});

describe("pourcentage", () => {
  it("calcule et arrête à 100", () => {
    expect(pourcentage(0, 100)).toBe(0);
    expect(pourcentage(1, 3)).toBe(33);
    expect(pourcentage(50, 100)).toBe(50);
    expect(pourcentage(100, 100)).toBe(100);
  });

  it("borne un compteur qui dépasse le total", () => {
    // Compteur incohérent (arrondi, reprise de job) : la barre ne doit pas
    // déborder de son cadre.
    expect(pourcentage(120, 100)).toBe(100);
    expect(pourcentage(-5, 100)).toBe(0);
  });

  it("reste 0 sur un total inconnu plutôt que NaN", () => {
    // `NaN` dans un `width` rend la barre invisible ; `0` la laisse vide.
    expect(pourcentage(0, 0)).toBe(0);
    expect(pourcentage(10, 0)).toBe(0);
    expect(pourcentage(NaN, 100)).toBe(0);
    expect(pourcentage(10, NaN)).toBe(0);
    expect(pourcentage(1, Infinity)).toBe(0);
  });
});

describe("empreinteCourte", () => {
  it("tronque à 12 caractères et signale l'absence", () => {
    const sha = "a".repeat(64);
    expect(empreinteCourte(sha)).toBe(`${"a".repeat(12)}…`);
    expect(empreinteCourte(null)).toBe("—");
    expect(empreinteCourte(undefined)).toBe("—");
  });
});

describe("essaiConcerne", () => {
  const A = "_sauvegardes/2026-10-01T211422Z-e450d4";

  it("accepte le couple sauvegarde + mode de l'essai", () => {
    expect(essaiConcerne({ source: A, mode: "bucket" }, { source: A, mode: "bucket" })).toBe(
      true,
    );
  });

  it("refuse dès que le mode a changé", () => {
    // LE cas qui compte : l'essai portait sur `bucket` (base intacte, seuls
    // des fichiers manquants), l'utilisateur bascule le sélecteur sur
    // `disaster`, et les chiffres qu'il a lus sous les yeux — « 28 fichiers à
    // écrire » — ne sont pas ceux d'un `disaster`, qui rejoue les épreuves en
    // base. Le rapport ne change pas, donc seule cette règle peut l'empêcher
    // d'autoriser l'écriture.
    expect(essaiConcerne({ source: A, mode: "bucket" }, { source: A, mode: "disaster" })).toBe(
      false,
    );
  });

  it("refuse dès que la sauvegarde a changé", () => {
    const B = "_sauvegardes/2026-10-02T090000Z-aaaaaa";
    expect(essaiConcerne({ source: A, mode: "bucket" }, { source: B, mode: "bucket" })).toBe(
      false,
    );
  });

  it("refuse un job sans source ni mode connus", () => {
    // Défaut fail-safe : une information manquante vaut refus.
    expect(essaiConcerne(null, { source: A, mode: "bucket" })).toBe(false);
    expect(essaiConcerne({}, { source: A, mode: "bucket" })).toBe(false);
  });
});
