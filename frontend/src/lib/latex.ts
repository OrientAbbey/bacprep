/**
 * Normalise des variantes de délimiteurs LaTeX que les modèles produisent
 * parfois malgré l'instruction de n'utiliser que $...$/$$...$$ (voir
 * core/assistant.py, `_build_prompt`) — `remark-math` (utilisé par
 * MarkdownContent) ne reconnaît QUE la syntaxe dollar, donc \( \), \[ \]
 * ou un \begin{...} nu ne seraient sinon jamais rendus et resteraient
 * affichés comme du texte brut illisible.
 *
 * Implémentation en machine à états ligne par ligne (remplace une version
 * regex globale sur tout le texte, qui touchait aussi l'intérieur des
 * blocs de code et ratait des cas limites) :
 * - l'intérieur des blocs de code fencés (``` ou ~~~) est laissé INTACT ;
 * - chaque bloc $$...$$, où qu'il apparaisse (au milieu d'un paragraphe,
 *   plusieurs sur une même ligne, à cheval sur plusieurs lignes), est
 *   isolé sur ses propres lignes entourées de lignes vides — condition
 *   nécessaire pour que remark-math le reconnaisse comme "math flow" ;
 * - les formules inline $...$ et les \$ échappés ne sont jamais touchés.
 *
 * Best-effort, pas un vrai parseur LaTeX : suffisant pour les cas usuels
 * (bloc affiché, formule en ligne, environnement aligned/matrix nu) sans
 * viser une couverture exhaustive de toute la syntaxe LaTeX possible.
 */

/** Teste si une ligne ouvre un bloc de code fencé (``` ou ~~~, avec
 * éventuellement une longueur supérieure et une info de langage). */
function isFence(line: string): boolean {
  return /^\s*(`{3,}|~{3,})/.test(line);
}

/** Convertit \[...\] et \(...\), et enveloppe les environnements
 * \begin{...} nus dans $$...$$ — appliqué entre deux passages de
 * l'isolation des blocs (voir normalizeLatexDelimiters). */
function convertDelimiters(markdown: string): string {
  let out = markdown;

  // \[ ... \] (bloc affiché) -> $$ ... $$. Le lookbehind (?<!\\) évite de
  // confondre le saut de ligne LaTeX \\[2pt] (dont le « \[ » réalisé par le
  // second backslash n'est PAS un délimiteur) c'est-à-dire de le convertir
  // puis de casser l'environnement aligned qui l'utilise.
  out = out.replace(/(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g, (_match, inner) => `$$${inner}$$`);

  // \( ... \) (en ligne) -> $ ... $
  out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_match, inner) => `$${inner}$`);

  // Un environnement \begin{...}...\end{...} laissé nu (pas déjà entre $$,
  // collés juste avant/après) est enveloppé dans $$ ... $$. Le lookbehind
  // (?<!\$\$\s) couvre le cas où le $$ est sur sa PROPRE ligne avant \
  // begin (ou séparé par un espace) : sans lui, un $$ déjà présent sur la
  // ligne voisine re-wrap l'environnement et produit un double $$...$$ que
  // remark-math ne sait pas lire. Grâce au premier passage d'isolation,
  // tous les blocs $$ sont déjà sur des lignes dédiées : ce cas est le seul
  // restant à exclure, l'attache ``$$begin`` étant capté par `before`.
  out = out.replace(
    /(?<!\$\$\s)(\$\$?)?\\begin\{(aligned|align\*?|matrix|pmatrix|bmatrix|cases|array)\}([\s\S]*?)\\end\{\2\}(\$\$?)?/g,
    (match, before, env, body, after) => {
      if (before && after) return match; // déjà correctement délimité
      return `$$\\begin{${env}}${body}\\end{${env}}$$`;
    }
  );

  return out;
}

/**
 * Phase d'isolation : parcourt le texte ligne à ligne. Hors blocs de code,
 * chaque segment $$...$$ trouvé (le délimiteur d'ouverture et de fermeture
 * peut être sur la même ligne ou sur des lignes différentes) est retiré de
 * son flux d'origine et réémis comme bloc autonome entouré de lignes vides.
 */
function isolateDisplayMath(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  // État du bloc $$ multiligne en cours de collecte (null = aucun).
  let collecting: string[] | null = null;

  /** Réémet un bloc math isolé, entouré de lignes vides. */
  function emitBlock(inner: string) {
    const body = inner.trim();
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push("$$", body, "$$");
    out.push("");
  }

  /** Traite le contenu texte d'une ligne hors bloc math multiligne :
   * découpe en segments $$...$$ complets sur la ligne ; le texte avant /
   * entre est vidé AVANT chaque bloc (pour conserver l'ordre de lecture),
   * chaque bloc complet est réémis isolé. Retourne le reste à collecter si
   * un $$ d'ouverture n'a pas de $$ de fermeture sur la même ligne. */
  function processLine(line: string): string | null {
    let rest = line;
    let pending = "";
    for (;;) {
      const open = rest.indexOf("$$");
      if (open === -1) {
        pending += rest;
        break;
      }
      // \$$ échappé : on déplace le curseur après l'échappement.
      if (open > 0 && rest[open - 1] === "\\") {
        pending += rest.slice(0, open + 2);
        rest = rest.slice(open + 2);
        continue;
      }
      pending += rest.slice(0, open);
      const afterOpen = rest.slice(open + 2);
      const close = afterOpen.indexOf("$$");
      if (close === -1) {
        if (pending.trim() !== "") out.push(pending);
        return afterOpen; // ouverture sans fermeture sur la ligne
      }
      if (pending.trim() !== "") out.push(pending);
      pending = "";
      emitBlock(afterOpen.slice(0, close));
      rest = afterOpen.slice(close + 2);
    }
    if (pending.trim() !== "") out.push(pending);
    return null;
  }

  for (const line of lines) {
    if (isFence(line)) {
      if (!inFence) {
        inFence = true;
        fenceMarker = line.match(/^\s*(`{3,}|~{3,})/)![1][0];
        out.push(line);
      } else if (line.trim().startsWith(fenceMarker)) {
        inFence = false;
        out.push(line);
      } else {
        out.push(line);
      }
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    if (collecting !== null) {
      const close = line.indexOf("$$");
      if (close === -1) {
        collecting.push(line);
      } else {
        collecting.push(line.slice(0, close));
        emitBlock(collecting.join("\n"));
        collecting = null;
        const rest = line.slice(close + 2);
        if (rest.trim() !== "") out.push(rest);
      }
      continue;
    }

    const remainder = processLine(line);
    if (remainder !== null) collecting = [remainder];
  }

  // Bloc $$ jamais refermé : on le restitue tel quel (comportement sûr,
  // remark-math affichera le texte brut plutôt que de perdre le contenu).
  if (collecting !== null) {
    out.push("$$", ...collecting);
  }

  return out.join("\n");
}

export function normalizeLatexDelimiters(markdown: string): string {
  // Deux passes d'isolation : la première met TOUS les blocs $$ existants sur
  // des lignes dédiées AVANT convertDelimiters, ce qui rend le lookbehind
  // (?<!\$\$\s) fiable (un \begin dans un $$ déjà présent n'est jamais
  // re-enveloppé). La seconde re-isole les éventuels blocs $$ créés par la
  // conversion (\begin nus, \[...\]).
  return isolateDisplayMath(convertDelimiters(isolateDisplayMath(markdown)));
}
