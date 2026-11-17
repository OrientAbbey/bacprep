import katex, { type KatexOptions } from "katex";
import { normalizeDisplayMathDelimitersPreservingOffsets, normalizeLatexDelimiters } from "./latex";

/**
 * Configuration UNIQUE du rendu LaTeX/KaTeX du projet.
 *
 * Toute zone qui affiche du Markdown mathématique passe par `MarkdownContent`,
 * lequel consomme ces options : le rendu est donc identique dans l'éditeur,
 * le lecteur, l'aperçu admin et l'export PDF.
 *
 * `trust: false` est conservé : le HTML brut via LaTeX (\href, \includegraphics…)
 * reste désactivé, comme pour le Markdown (voir MarkdownContent).
 */
export const KATEX_OPTIONS: Omit<KatexOptions, "displayMode" | "throwOnError"> = {
  strict: "ignore",
  trust: false,
  output: "htmlAndMathml",
};

/** Options strictes pour le contrôle des formules générées par l'atelier IA. */
export const KATEX_OPTIONS_STRICT: KatexOptions = {
  ...KATEX_OPTIONS,
  throwOnError: true,
};

let promesseExtensions: Promise<void> | null = null;

/**
 * Charge les extensions KaTeX **à la demande** (chunk Vite séparé) :
 * - mhchem fournit `\ce{…}` (formules/équations chimiques) et `\pu{…}` (unités).
 *
 * Le build ESM de katex (`katex/contrib/mhchem` → dist/contrib/mhchem.mjs)
 * importe lui-même le même module katex : aucun global n'est nécessaire.
 * L'appel est idempotent ; en cas d'échec la promesse est réinitialisée pour
 * permettre un nouvel essai.
 */
export function chargerExtensions(): Promise<void> {
  if (!promesseExtensions) {
    promesseExtensions = import("katex/contrib/mhchem")
      .then(() => undefined)
      .catch((erreur: unknown) => {
        promesseExtensions = null;
        throw erreur;
      });
  }
  return promesseExtensions;
}

/** Normalise les délimiteurs LaTeX selon le contexte d'affichage. */
export function normaliserPourRendu(markdown: string, { preserverOffsets }: { preserverOffsets: boolean }): string {
  return preserverOffsets
    ? normalizeDisplayMathDelimitersPreservingOffsets(markdown)
    : normalizeLatexDelimiters(markdown);
}

/**
 * Compile une formule avec les options strictes. Lève une erreur si la
 * formule est invalide. Utilisé par l'atelier IA avant insertion dans l'éditeur.
 */
export function verifierFormule(formule: string, bloc: boolean): void {
  katex.renderToString(formule, { ...KATEX_OPTIONS_STRICT, displayMode: bloc });
}
