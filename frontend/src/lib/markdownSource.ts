import { visit } from "unist-util-visit";

/**
 * Plugin rehype interne : recopie la position source (offsets dans le
 * Markdown d'origine) de chaque élément de bloc dans des attributs HTML
 * `data-src-start` / `data-src-end`. Utilisé par le lecteur (ViewerPage)
 * pour retrouver, à partir d'une sélection de texte faite par
 * l'utilisateur dans le rendu, le Markdown BRUT correspondant (formules
 * LaTeX, tableaux, syntaxe d'image comprises) plutôt que le texte affiché
 * une fois nettoyé/rendu — c'est ce Markdown brut qui est ensuite transmis
 * à l'assistant IA comme contexte.
 *
 * IMPORTANT : ce plugin doit recevoir le Markdown ORIGINAL, non modifié
 * (ancres {#id} comprises) — sinon les offsets calculés ne correspondent
 * plus au texte source qu'on veut ensuite découper (voir
 * extractSourceMarkdownForSelection). Le nettoyage visuel des ancres se
 * fait séparément, à un niveau qui ne touche pas aux offsets : voir
 * `rehypeStripAnchorText` ci-dessous, qui n'altère que le texte affiché
 * (value des noeuds texte), jamais la position des éléments parents.
 */
export function rehypeSourceOffsets() {
  return (tree: any) => {
    visit(tree, "element", (node: any) => {
      if (node.position?.start?.offset != null && node.position?.end?.offset != null) {
        node.properties = node.properties || {};
        node.properties["data-src-start"] = node.position.start.offset;
        node.properties["data-src-end"] = node.position.end.offset;
      }
    });
  };
}

/**
 * Retire visuellement les ancres {#id} du texte affiché en mutant
 * uniquement la valeur des noeuds texte (hast), sans toucher aux
 * positions des éléments parents — ce qui garde `rehypeSourceOffsets`
 * exact même quand ce plugin est actif en même temps.
 */
export function rehypeStripAnchorText() {
  return (tree: any) => {
    visit(tree, "text", (node: any) => {
      // On appelle directement .replace() (jamais .test()/.exec() sur un
      // regex partagé avec le flag "g" — cela mute lastIndex et produit des
      // faux négatifs intermittents d'un noeud texte à l'autre).
      if (typeof node.value === "string") {
        node.value = node.value.replace(/\s*\{#[^}]+\}/g, "");
      }
    });
  };
}

/**
 * Étant donné un noeud DOM (généralement anchorNode/focusNode d'une
 * Selection), remonte les ancêtres jusqu'à trouver l'attribut
 * data-src-start / data-src-end posé par le plugin ci-dessus.
 */
function findSourceOffsets(node: Node | null): { start: number; end: number } | null {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  while (el) {
    const start = el.getAttribute("data-src-start");
    const end = el.getAttribute("data-src-end");
    if (start != null && end != null) {
      return { start: parseInt(start, 10), end: parseInt(end, 10) };
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Calcule, à partir de la sélection de texte courante et du Markdown
 * source complet, le passage Markdown BRUT (formules/tableaux/images
 * compris) qui correspond le mieux à la sélection. Retourne `null` si
 * aucun ancêtre avec position source n'a pu être trouvé (repli sur le
 * texte brut de la sélection dans ce cas, géré par l'appelant).
 */
export function extractSourceMarkdownForSelection(
  selection: Selection,
  fullMarkdown: string
): string | null {
  if (selection.rangeCount === 0) return null;
  const startInfo = findSourceOffsets(selection.anchorNode);
  const endInfo = findSourceOffsets(selection.focusNode);
  if (!startInfo && !endInfo) return null;

  const candidates = [startInfo, endInfo].filter(Boolean) as { start: number; end: number }[];
  const start = Math.min(...candidates.map((c) => c.start));
  const end = Math.max(...candidates.map((c) => c.end));
  if (start >= end || end > fullMarkdown.length) return null;

  return fullMarkdown.slice(start, end).trim();
}
