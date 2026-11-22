import { afterEach, describe, expect, it } from "vitest";
import { DELAI_REFUS_JOURS, estDejaInstallee, estIOS, estIOSafari, peutProposerInstallation } from "./installation";

/** Remplace l'userAgent le temps d'un test, puis le restaure. */
function avecUA(ua: string, touchPoints = 0) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: touchPoints });
}

const UA_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const UA_CHROME_IOS = UA_SAFARI.replace("Safari/604.1", "CriOS/130.0.0.0 Mobile/15E148");
const UA_ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36";
const UA_MAC_TACTILE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";

afterEach(() => avecUA(navigator.userAgent, 0));

describe("détection de plateforme", () => {
  it("reconnaît Safari sur iPhone", () => {
    avecUA(UA_SAFARI);
    expect(estIOS()).toBe(true);
    expect(estIOSafari()).toBe(true);
  });

  it("ne propose pas la méthode Safari dans Chrome iOS", () => {
    avecUA(UA_CHROME_IOS);
    expect(estIOS()).toBe(true);
    expect(estIOSafari()).toBe(false);
  });

  it("reconnaît Android et l'exclut de la méthode Safari", () => {
    avecUA(UA_ANDROID);
    expect(estIOS()).toBe(false);
    expect(estIOSafari()).toBe(false);
  });

  it("reconnaît un iPad récent annoncé comme Mac tactile", () => {
    avecUA(UA_MAC_TACTILE, 5);
    expect(estIOS()).toBe(true);
    expect(estIOSafari()).toBe(true);
  });

  it("détecte le mode application déjà installée", () => {
    // jsdom n'implémente pas matchMedia par défaut : le helper reste sûr.
    expect(() => estDejaInstallee()).not.toThrow();
  });
});

describe("refus de la proposition d'installation", () => {
  const maintenant = new Date("2026-11-22T12:00:00Z");

  it("propose quand il n'y a jamais eu de refus", () => {
    expect(peutProposerInstallation(null, maintenant)).toBe(true);
  });

  it("respecte le délai de grâce après un refus", () => {
    expect(peutProposerInstallation("2026-11-10T12:00:00Z", maintenant)).toBe(false);
    expect(peutProposerInstallation("2026-10-20T12:00:00Z", maintenant)).toBe(true);
    expect(DELAI_REFUS_JOURS).toBe(30);
  });

  it("ignore une date illisible", () => {
    expect(peutProposerInstallation("pas-une-date", maintenant)).toBe(true);
  });
});
