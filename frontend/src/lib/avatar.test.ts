import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { setLang } from "../i18n";
import { messageEnvoiPhoto, messagePhoto, refusPhoto, urlAvatar } from "./avatar";

describe("urlAvatar", () => {
  it("porte la version dans ?v=, encodée (l'horodatage ISO contient « + » et « : »)", () => {
    expect(urlAvatar("2026-10-24T11:12:59.867382+00:00")).toMatch(/\/api\/me\/avatar\?v=2026-10-24T11%3A12%3A59\.867382%2B00%3A00$/);
  });
});

describe("refusPhoto", () => {
  it("laisse partir une image de moins de 2 Mo, refuse le reste sans envoi", () => {
    expect(refusPhoto({ type: "image/jpeg", size: 2 * 1024 * 1024 })).toBeNull();
    expect(refusPhoto({ type: "image/png", size: 2 * 1024 * 1024 + 1 })).toBe("Photo trop lourde (2 Mo maximum)");
    expect(refusPhoto({ type: "application/pdf", size: 10 })).toBe("Fichier non reconnu comme image (PNG, JPEG, WebP ou GIF)");
    expect(refusPhoto({ type: "", size: 10 })).toBe("Fichier non reconnu comme image (PNG, JPEG, WebP ou GIF)");
  });
});

describe("messageEnvoiPhoto", () => {
  beforeEach(() => setLang("fr"));
  it("traduit les refus du serveur (413, 415, 429) et retombe sur un message générique", () => {
    expect(messageEnvoiPhoto(new ApiError(413, "Photo trop lourde"))).toBe("Photo trop lourde (2 Mo maximum)");
    expect(messageEnvoiPhoto(new ApiError(415, null))).toBe(messagePhoto(415));
    expect(messageEnvoiPhoto(new ApiError(429, null))).toBe("Trop d'envois de photo — réessaie plus tard");
    expect(messageEnvoiPhoto(new ApiError(500, null))).toBe("L'envoi de la photo a échoué — réessaie.");
    expect(messageEnvoiPhoto(new TypeError("réseau"))).toBe("L'envoi de la photo a échoué — réessaie.");
  });
  it("suit la langue choisie", () => {
    setLang("en");
    expect(messageEnvoiPhoto(new ApiError(413, null))).toBe("Photo too large (2 MB maximum)");
    expect(refusPhoto({ type: "text/plain", size: 1 })).toBe("File not recognised as an image (PNG, JPEG, WebP or GIF)");
  });
});
