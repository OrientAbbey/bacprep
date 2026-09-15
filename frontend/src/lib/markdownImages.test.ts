import { describe, expect, it } from "vitest";
import type { Root } from "hast";
import { rehypeImageWidths } from "./markdownImages";

function treeWithImg(src: string, style?: string): Root {
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "p",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "img",
            properties: { src, alt: "figure", ...(style ? { style } : {}) },
            children: [],
          },
        ],
      },
    ],
  };
}

/** Applique le plugin à un arbre et renvoie la propriété `src` de l'<img>. */
function apply(src: string, style?: string): { src: unknown; style: unknown } {
  const tree = treeWithImg(src, style);
  rehypeImageWidths()(tree);
  const img = (tree.children[0] as any).children[0];
  return { src: img.properties.src, style: img.properties.style };
}

describe("rehypeImageWidths", () => {
  it("applique la largeur #w= et retire le fragment du src", () => {
    const { src, style } = apply("/api/files/abc#w=300");
    expect(src).toBe("/api/files/abc");
    expect(style).toBe("width: 300px; max-width: 100%; height: auto;");
  });

  it("laisse intacte une image sans fragment", () => {
    const { src, style } = apply("/api/files/abc");
    expect(src).toBe("/api/files/abc");
    expect(style).toBeUndefined();
  });

  it("ignore un fragment non-#w", () => {
    const { src, style } = apply("/api/files/abc#section");
    expect(src).toBe("/api/files/abc#section");
    expect(style).toBeUndefined();
  });

  it("conserve un style existant et force la largeur", () => {
    const { src, style } = apply("/api/files/abc#w=640", "display: block");
    expect(src).toBe("/api/files/abc");
    expect(style).toContain("display: block");
    expect(style).toMatch(/width: 640px/);
  });
});