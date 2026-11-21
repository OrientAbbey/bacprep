import { afterEach, describe, expect, it, vi } from "vitest";
import { copierTexte } from "./pressePapiers";

describe("copierTexte", () => {
  afterEach(() => vi.unstubAllGlobals());
  const texte = "# Titre\n\n  - item  avec  espaces\n```action\n{\"a\":1}\n```\n";

  it("copie le texte brut exact (espaces et retours à la ligne) via l'API presse-papiers", async () => {
    const ecrire = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: ecrire } });
    vi.stubGlobal("window", { isSecureContext: true });
    expect(await copierTexte(texte)).toBe(true);
    expect(ecrire).toHaveBeenCalledWith(texte);
  });

  it("bascule sur execCommand quand l'API est refusée ou indisponible (http)", async () => {
    const zone = { value: "", setAttribute: vi.fn(), style: { cssText: "" }, select: vi.fn(), remove: vi.fn() };
    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("refusé")) } });
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("document", { createElement: () => zone, body: { append: vi.fn() }, execCommand });
    expect(await copierTexte(texte)).toBe(true);
    expect(zone.value).toBe(texte);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(zone.remove).toHaveBeenCalled();
  });

  it("renvoie false si aucune méthode ne fonctionne", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("document", { createElement: () => { throw new Error("pas de DOM"); } });
    expect(await copierTexte(texte)).toBe(false);
  });
});
