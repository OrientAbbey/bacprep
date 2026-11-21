import { afterEach, describe, expect, it, vi } from "vitest";
import { estErreurReseau, etatConnexion, signalerReseau } from "./connexion";

describe("suivi du réseau", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    signalerReseau(true);
  });

  it("reconnaît une coupure réseau (TypeError de fetch) et pas une erreur HTTP", () => {
    expect(estErreurReseau(new TypeError("Failed to fetch"))).toBe(true);
    expect(estErreurReseau(new Error("HTTP 500"))).toBe(false);
  });

  it("passe hors-ligne sur une coupure et revient en ligne sur une réponse", () => {
    vi.stubGlobal("navigator", { onLine: true });
    signalerReseau(false);
    expect(etatConnexion()).toBe("hors-ligne");
    signalerReseau(true);
    expect(etatConnexion()).toBe("ok");
  });

  it("reste hors-ligne tant que le navigateur se déclare hors-ligne, même si une réponse arrive du cache", () => {
    vi.stubGlobal("navigator", { onLine: true });
    signalerReseau(false);
    vi.stubGlobal("navigator", { onLine: false }); // lecture hors-ligne : le service worker répond depuis son cache
    signalerReseau(true);
    expect(etatConnexion()).toBe("hors-ligne");
    vi.stubGlobal("navigator", { onLine: true });
    signalerReseau(true);
    expect(etatConnexion()).toBe("ok");
  });
});
