import { describe, expect, it } from "vitest";
import { imagesDe } from "./horsLigne";

describe("imagesDe", () => {
  it("extrait les URLs d'images, jeton compris, sans doublon", () => {
    const md = "![a](/api/files/abc123?token=1700.deadbeef#w=300) texte ![b](/api/files/def-45_6) ![a](/api/files/abc123?token=1700.deadbeef)";
    expect(imagesDe(md)).toEqual(["/api/files/abc123?token=1700.deadbeef", "/api/files/def-45_6"]);
  });
  it("renvoie une liste vide sans image", () => {
    expect(imagesDe("# Sujet\n\nQuestion 1")).toEqual([]);
  });
  it("s'arrête avant les guillemets d'un JSON", () => {
    expect(imagesDe('{"c":"![x](/api/files/z9?token=5.ab)"}')).toEqual(["/api/files/z9?token=5.ab"]);
  });
});
