import { describe, expect, it } from "vitest";
import { extraireBaliseImage, remplacerLargeur } from "./shared";

describe("extraireBaliseImage (matching sans jeton)", () => {
  const urlAsset = "/api/files/img-abc123?token=signe-a-l-affichage";

  it("matche une balise portant un jeton DIFFÉRENT (ancien upload)", () => {
    const md = "![figure](/api/files/img-abc123?token=jeton-perime#w=300)";
    const r = extraireBaliseImage(md, urlAsset);
    expect(r.presente).toBe(true);
    expect(r.largeur).toBe(300);
  });

  it("matche une balise sans jeton ni fragment", () => {
    const md = "![figure](/api/files/img-abc123)";
    expect(extraireBaliseImage(md, urlAsset).presente).toBe(true);
  });

  it("matche une balise avec jeton mais sans largeur", () => {
    const md = "![figure](/api/files/img-abc123?token=jeton-perime)";
    const r = extraireBaliseImage(md, urlAsset);
    expect(r.presente).toBe(true);
    expect(r.largeur).toBe(0);
  });

  it("ne matche pas une autre image", () => {
    const md = "![figure](/api/files/autre-img#w=200)";
    expect(extraireBaliseImage(md, urlAsset).presente).toBe(false);
  });
});

describe("remplacerLargeur (sans casser le jeton de la balise)", () => {
  it("réécrit la largeur en conservant le jeton de la balise", () => {
    const md = "![figure](/api/files/img-abc123?token=jeton-perime#w=300)";
    const out = remplacerLargeur(md, "/api/files/img-abc123?token=autre-jeton", 480);
    expect(out).toBe("![figure](/api/files/img-abc123?token=jeton-perime#w=480)");
  });

  it("retire la largeur (#w=0 = Pleine) en conservant le jeton", () => {
    const md = "![figure](/api/files/img-abc123?token=jeton-perime#w=200)";
    const out = remplacerLargeur(md, "/api/files/img-abc123?token=frais", 0);
    expect(out).toBe("![figure](/api/files/img-abc123?token=jeton-perime)");
  });

  it("ajoute la largeur à une balise existante", () => {
    const md = "![figure](/api/files/img-abc123)";
    expect(remplacerLargeur(md, "/api/files/img-abc123?token=frais", 640)).toBe(
      "![figure](/api/files/img-abc123#w=640)",
    );
  });

  it("laisse le markdown intact si la balise est absente", () => {
    const md = "![figure](/api/files/autre-img)";
    expect(remplacerLargeur(md, "/api/files/img-abc123?token=frais", 480)).toBe(md);
  });
});