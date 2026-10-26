import { beforeEach, describe, expect, it } from "vitest";
import type { ActiviteItem } from "../api/types";
import { setLang } from "../i18n";
import { libelleActivite } from "./activite";
import { libelleDiscussion } from "./libelleDiscussion";

const item = (o: Partial<ActiviteItem>): ActiviteItem => ({ type: "consultation", date: "2026-01-01", libelle: "", epreuve_id: null, details: "", ...o });
const consultation = item({
  libelle: "Consultation de Physique — terminale (BAC 2024)",
  cle: "Consultation de {matiere} — {classe} ({evaluation} {annee})",
  params: { matiere: "Physique", classe: "terminale", evaluation: "BAC", annee: "2024" },
});

describe("libelleActivite", () => {
  beforeEach(() => setLang("fr"));
  it("rend la phrase française à partir du gabarit et des paramètres", () => {
    expect(libelleActivite(consultation)).toBe("Consultation de Physique — terminale (BAC 2024)");
  });
  it("traduit le gabarit en anglais et laisse les données (matière, classe) telles quelles", () => {
    setLang("en");
    expect(libelleActivite(consultation)).toBe("Viewed Physique — terminale (BAC 2024)");
  });
  it("traduit les mots du produit contenus dans les paramètres (portée, statut) et le libellé de discussion", () => {
    setLang("en");
    expect(libelleActivite(item({ cle: "Abonnement {statut} — {portee}", params: { statut: "annulee", portee: "Série complète" } }))).toBe("Subscription cancelled — Full stream");
    expect(libelleActivite(item({ cle: "Discussion « {libelle} »", params: { libelle: "Discussion générale 2" } }))).toBe("Conversation “General conversation 2”");
  });
  it("retombe sur le libellé du serveur pour une entrée sans gabarit (ancien serveur)", () => {
    setLang("en");
    expect(libelleActivite(item({ libelle: "Phrase brute" }))).toBe("Phrase brute");
  });
});

describe("libelleDiscussion", () => {
  it("traduit les libellés par défaut (suffixe conservé) et le préfixe « Passage : »", () => {
    setLang("en");
    expect(libelleDiscussion("Discussion générale")).toBe("General conversation");
    expect(libelleDiscussion("Discussion générale 3")).toBe("General conversation 3");
    expect(libelleDiscussion("Passage : la dérivée")).toBe("Passage: la dérivée");
    expect(libelleDiscussion("Ma question libre")).toBe("Ma question libre");
    setLang("fr");
  });
});
