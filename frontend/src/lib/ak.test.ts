import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { gainPourSerie, gainProchaineConnexion, jourUTC, libelleMouvementAK } from "./ak";

describe("gainPourSerie", () => {
  it("respecte les paliers cumulatifs du serveur (3 / 7 / 10 AK)", () => {
    expect(gainPourSerie(0)).toBe(0);
    expect([1, 2, 3].map(gainPourSerie)).toEqual([3, 3, 3]);
    expect([4, 5, 6].map(gainPourSerie)).toEqual([7, 7, 7]);
    expect([7, 8, 30].map(gainPourSerie)).toEqual([10, 10, 10]);
  });
});

describe("gainProchaineConnexion", () => {
  it("annonce le gain du jour 1 sur un compte sans historique", () => {
    expect(gainProchaineConnexion(0, null, "2026-11-14")).toBe(3);
  });
  it("annonce le gain du jour suivant pour une série en cours", () => {
    expect(gainProchaineConnexion(2, "2026-11-13", "2026-11-14")).toBe(3); // -> jour 3
    expect(gainProchaineConnexion(3, "2026-11-13", "2026-11-14")).toBe(7); // -> jour 4
    expect(gainProchaineConnexion(6, "2026-11-13", "2026-11-14")).toBe(10); // -> jour 7
    expect(gainProchaineConnexion(9, "2026-11-13", "2026-11-14")).toBe(10);
  });
  it("repart au gain du jour 1 après 7 jours d'absence (règle de reset)", () => {
    expect(gainProchaineConnexion(9, "2026-11-07", "2026-11-14")).toBe(3);
    expect(gainProchaineConnexion(9, "2026-11-06", "2026-11-14")).toBe(3);
    // 6 jours d'écart : la série continue.
    expect(gainProchaineConnexion(9, "2026-11-08", "2026-11-14")).toBe(10);
  });
  it("traite une date illisible ou future comme une première connexion", () => {
    expect(gainProchaineConnexion(5, "pas-une-date", "2026-11-14")).toBe(3);
    expect(gainProchaineConnexion(5, "2026-12-01", "2026-11-14")).toBe(3);
  });
});

describe("jourUTC", () => {
  it("rend la date ISO en UTC, comme le serveur", () => {
    expect(jourUTC(new Date("2026-11-14T23:30:00Z"))).toBe("2026-11-14");
    expect(jourUTC(new Date("2026-11-14T00:10:00Z"))).toBe("2026-11-14");
  });
});

describe("libelleMouvementAK", () => {
  beforeEach(() => setLang("fr"));
  it("traduit les motifs du serveur en phrases lisibles", () => {
    expect(libelleMouvementAK("connexion_j1")).toBe("Récompense de connexion — jour 1");
    expect(libelleMouvementAK("connexion_j7plus")).toBe("Récompense de connexion — jour 7+");
    expect(libelleMouvementAK("achat:abc123")).toBe("Achat d'un abonnement");
    expect(libelleMouvementAK("ajustement_admin")).toBe("Ajustement de l'équipe");
  });
  it("affiche le motif tel quel s'il est inconnu (nouvelle règle serveur)", () => {
    expect(libelleMouvementAK("prime_parrainage")).toBe("prime_parrainage");
  });
  it("passe en anglais", () => {
    setLang("en");
    expect(libelleMouvementAK("connexion_j1")).toBe("Sign-in reward — day 1");
    expect(libelleMouvementAK("achat:x")).toBe("Subscription purchase");
    expect(libelleMouvementAK("ajustement_admin")).toBe("Team adjustment");
    setLang("fr");
  });
});
