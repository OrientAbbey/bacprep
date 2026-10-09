import { describe, expect, it } from "vitest";
import { ApiError, ApiTimeoutError } from "../api/client";
import { messageErreurConnexion } from "./messageConnexion";

describe("messageErreurConnexion", () => {
  it("n'accuse l'e-mail et le jeton que pour un vrai refus (401/403)", () => {
    expect(messageErreurConnexion(new ApiError(401, "Jeton invalide"))).toContain("vérifie l'e-mail et le jeton");
    expect(messageErreurConnexion(new ApiError(403, "x"))).toContain("vérifie l'e-mail et le jeton");
  });
  it("signale un réseau coupé (fetch rejeté en TypeError) sans accuser les identifiants", () => {
    const m = messageErreurConnexion(new TypeError("Failed to fetch"));
    expect(m).toContain("Pas de connexion Internet");
    expect(m).not.toContain("jeton");
  });
  it("distingue délai dépassé, limite de tentatives et erreur serveur", () => {
    expect(messageErreurConnexion(new ApiTimeoutError(60000))).toContain("ne répond pas");
    expect(messageErreurConnexion(new ApiError(429, "Trop de tentatives, réessaie plus tard"))).toBe("Trop de tentatives, réessaie plus tard");
    expect(messageErreurConnexion(new ApiError(429, { x: 1 }))).toContain("Trop de tentatives");
    expect(messageErreurConnexion(new ApiError(500, "ADMIN_ROOT non configuré"))).toContain("Erreur du serveur");
    expect(messageErreurConnexion(new ApiError(422, "x"))).toContain("code 422");
  });
});
