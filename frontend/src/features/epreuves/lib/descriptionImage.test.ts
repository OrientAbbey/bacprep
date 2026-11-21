import { describe, expect, it } from "vitest";
import { appliquerDescription, DESCRIPTION_MAX, descriptionExistante, nettoyerDescription } from "./descriptionImage";

describe("appliquerDescription", () => {
  it("remplace l'alt par défaut « légende » et garde l'URL signée et la taille", () => {
    const r = appliquerDescription("Avant ![légende](/api/files/abc123?token=x#w=300) après", "abc123", "Un cercle de centre O.");
    expect(r.markdown).toBe("Avant ![Un cercle de centre O.](/api/files/abc123?token=x#w=300) après");
    expect([r.remplacees, r.conservees]).toEqual([1, 0]);
  });
  it("remplace aussi un alt vide, et toutes les occurrences de la même image", () => {
    const r = appliquerDescription("![](/api/files/abc123)\n\n![Légende](/api/files/abc123#w=200)", "abc123", "Courbe.");
    expect(r.markdown).toBe("![Courbe.](/api/files/abc123)\n\n![Courbe.](/api/files/abc123#w=200)");
    expect(r.remplacees).toBe(2);
  });
  it("n'écrase JAMAIS une description déjà rédigée", () => {
    const md = "![Triangle ABC rectangle en A](/api/files/abc123)";
    const r = appliquerDescription(md, "abc123", "Autre chose");
    expect(r.markdown).toBe(md);
    expect([r.remplacees, r.conservees]).toEqual([0, 1]);
  });
  it("ne touche pas les autres images, ni un identifiant qui commence pareil", () => {
    const md = "![légende](/api/files/abc1234) ![légende](/api/files/zzz) ![légende](https://x.org/abc123)";
    const r = appliquerDescription(md, "abc123", "D");
    expect(r.markdown).toBe(md);
    expect(r.remplacees).toBe(0);
  });
  it("aucun crochet ni saut de ligne ne peut sortir de la description", () => {
    const r = appliquerDescription("![légende](/api/files/a1)", "a1", "ligne\nun [deux]");
    expect(r.markdown).toBe("![ligne un deux](/api/files/a1)");
    expect(r.markdown.match(/\]/g)?.length).toBe(1);
  });
  it("un identifiant contenant des caractères spéciaux est échappé", () => {
    expect(appliquerDescription("![légende](/api/files/a.b)", "a.b", "D").remplacees).toBe(1);
    expect(appliquerDescription("![légende](/api/files/axb)", "a.b", "D").remplacees).toBe(0);
  });

  it("ecraser=true remplace aussi une description rédigée (choix explicite de l'admin), toujours sans crochets", () => {
    const r = appliquerDescription("![Ancienne](/api/files/a1#w=200)", "a1", "Nouvelle [version]", true);
    expect(r.markdown).toBe("![Nouvelle version](/api/files/a1#w=200)");
    expect([r.remplacees, r.conservees]).toEqual([1, 0]);
  });
  it("descriptionExistante : première description rédigée, ignore « légende » et les autres images", () => {
    const mds = ["![légende](/api/files/a1) ![Autre image](/api/files/zz)", "![Un cercle](/api/files/a1)"];
    expect(descriptionExistante(mds, "a1")).toBe("Un cercle");
    expect(descriptionExistante(["![légende](/api/files/a1)"], "a1")).toBe("");
    expect(descriptionExistante([], "a1")).toBe("");
  });
  it("nettoyerDescription : une ligne, sans crochets, bornée avec « … »", () => {
    expect(nettoyerDescription("a\n\nb [c]")).toBe("a b c");
    const long = nettoyerDescription("x".repeat(DESCRIPTION_MAX + 50));
    expect(long.length).toBe(DESCRIPTION_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});
