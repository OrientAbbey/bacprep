import { beforeEach, describe, expect, it } from "vitest";
import en from "./locales/en.json";
import { getLang, setLang, t } from "./i18n";

describe("i18n", () => {
  beforeEach(() => setLang("fr"));
  it("renvoie le français par défaut et interpole les variables", () => {
    expect(getLang()).toBe("fr");
    expect(t("Fermer")).toBe("Fermer");
    expect(t("Fermer la discussion {label}", { label: "Maths" })).toBe("Fermer la discussion Maths");
  });
  it("traduit en anglais, interpole, et retombe sur le français si la clé est inconnue", () => {
    setLang("en");
    expect(t("Fermer")).toBe("Close");
    expect(t("Membre depuis le {d}", { d: "1 Jan" })).toBe("Member since 1 Jan");
    expect(t("Phrase jamais traduite")).toBe("Phrase jamais traduite");
  });
  it("garde les mêmes variables {x} dans chaque traduction que dans sa clé", () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    const ecarts = Object.entries(en as Record<string, string>).filter(([fr, e]) => vars(fr) !== vars(e));
    expect(ecarts).toEqual([]);
  });
  it("n'a aucune traduction vide ni identique à une clé qui contient des accents sans raison", () => {
    for (const [fr, e] of Object.entries(en as Record<string, string>)) expect(e.trim(), fr).not.toBe("");
  });
});
