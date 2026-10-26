import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { setLang } from "../i18n";
import { detailServeur } from "./detailServeur";

describe("detailServeur", () => {
  afterEach(() => setLang("fr"));
  it("déballe le corps JSON complet d'un ApiError, une chaîne brute, ou une erreur enrichie du flux", () => {
    expect(detailServeur(new ApiError(409, { detail: "Discussion introuvable" }))).toBe("Discussion introuvable");
    expect(detailServeur(new ApiError(429, "Trop de tentatives"))).toBe("Trop de tentatives");
    expect(detailServeur(Object.assign(new Error("x"), { detail: { detail: "Épreuve introuvable" } }))).toBe("Épreuve introuvable");
  });
  it("renvoie null quand il n'y a rien d'exploitable (validation 422, corps vide, chaîne blanche)", () => {
    expect(detailServeur(new ApiError(422, { detail: [{ msg: "champ requis" }] }))).toBeNull();
    expect(detailServeur(new ApiError(500, null))).toBeNull();
    expect(detailServeur(new ApiError(400, { detail: "  " }))).toBeNull();
    expect(detailServeur(undefined)).toBeNull();
  });
  it("traduit le message du serveur dans la langue choisie", () => {
    setLang("en");
    expect(detailServeur(new ApiError(409, { detail: "Tu as déjà signalé ce problème sur cette épreuve — il est en attente de traitement." }))).toBe(
      "You already reported this problem on this paper — it is awaiting review.",
    );
  });
});
