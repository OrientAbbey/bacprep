import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { liensPartage, partageNatifDisponible, texteInvitation, urlSite } from "./invitation";

describe("liensPartage", () => {
  const url = "https://bacprep.example/?a=1&b=2";
  const texte = "Rejoins-moi : épreuves & corrigés !";
  const liens = Object.fromEntries(liensPartage(url, texte).map((l) => [l.id, l.href]));

  it("encode le message et l'adresse (caractères réservés, accents, esperluette) pour chaque application", () => {
    expect(new URL(liens.whatsapp).searchParams.get("text")).toBe(`${texte} ${url}`);
    expect(liens.whatsapp.startsWith("https://wa.me/?text=")).toBe(true);
    expect(new URL(liens.facebook).searchParams.get("u")).toBe(url);
    const tg = new URL(liens.telegram);
    expect(tg.searchParams.get("url")).toBe(url);
    expect(tg.searchParams.get("text")).toBe(texte);
    const mail = new URL(liens.email);
    expect(mail.protocol).toBe("mailto:");
    expect(new URLSearchParams(mail.search).get("body")).toBe(`${texte} ${url}`);
  });
  it("propose exactement WhatsApp, Facebook, Telegram et e-mail, dans cet ordre", () => {
    expect(liensPartage(url, texte).map((l) => l.id)).toEqual(["whatsapp", "facebook", "telegram", "email"]);
  });
});

describe("invitation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setLang("fr");
  });
  it("partage la racine du site", () => {
    expect(urlSite("https://bacprep.example")).toBe("https://bacprep.example/");
  });
  it("traduit le message selon la langue choisie", () => {
    expect(texteInvitation()).toContain("Rejoins-moi");
    setLang("en");
    expect(texteInvitation()).toContain("Join me");
    expect(liensPartage("https://x.cm/", "t").find((l) => l.id === "email")?.label).toBe("Email");
  });
  it("détecte la feuille de partage du système, absente de nombreux navigateurs de bureau", () => {
    vi.stubGlobal("navigator", {});
    expect(partageNatifDisponible()).toBe(false);
    vi.stubGlobal("navigator", { share: () => Promise.resolve() });
    expect(partageNatifDisponible()).toBe(true);
  });
});
