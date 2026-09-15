import type { Root } from "hast";
import { visit } from "unist-util-visit";

/**
 * Rendu de la taille d'affichage des images d'une épreuve.
 *
 * Une image peut porter une taille d'affichage persistée DANS le Markdown,
 * sous la forme d'un fragment d'URL : `![Légende](/api/files/{id}#w=300)`.
 * Le fragment n'a ni espace ni parenthèse — il est donc conservé par le
 * parseur CommonMark dans l'attribut `src`, sans casser la regex unique
 * `extraits.IMAGE_MD_RE` du backend ni le chargement réel (un navigateur
 * ignore le fragment dans la requête d'image).
 *
 * Ce plugin rehype lit ce fragment à l'affichage, le retire du `src`
 * (sinon il apparaîtrait dans les outils réseau et casserait les fichiers
 * externes) et applique la largeur demandée. `max-width: 100%` garantit
 * qu'une image élargie ne déborde jamais du lecteur, mobile compris.
 */
const IMAGE_WIDTH_RE = /#w=(\d+)\s*$/;

export function rehypeImageWidths() {
  return (tree: Root) => {
    visit(tree, "element", (node) => {
      if (node.tagName !== "img") return;
      const src = node.properties?.src;
      if (typeof src !== "string") return;
      const match = IMAGE_WIDTH_RE.exec(src);
      if (!match) return;
      node.properties.src = src.replace(/#w=\d+\s*$/, "");
      const precedent = typeof node.properties.style === "string" ? node.properties.style : "";
      node.properties.style = `${precedent ? precedent.trimEnd() + "; " : ""}width: ${match[1]}px; max-width: 100%; height: auto;`;
    });
  };
}