/**
 * Normalise des variantes de délimiteurs LaTeX que les modèles produisent
 * parfois malgré l'instruction de n'utiliser que $...$/$$...$$ (voir
 * core/assistant.py, `_build_prompt`) — `remark-math` (utilisé par
 * MarkdownContent) ne reconnaît QUE la syntaxe dollar, donc \( \), \[ \]
 * ou un \begin{...} nu ne seraient sinon jamais rendus et resteraient
 * affichés comme du texte brut illisible.
 *
 * Deux phases :
 * 1. `convertDelimiters` (scanner caractère par caractère) — \[ \] et
 *    \( \) convertis en $$ $$ / $ $, environnements \begin{...} nus
 *    enveloppés, et blocs $$ déjà présents conservés ; les corps ne sont
 *    JAMAIS rescannés (pas de double enveloppement, y compris pour un
 *    \begin{aligned} multiligne servi DANS un \[ \]) ;
 * 2. l'intérieur des blocs de code fencés (``` ou ~~~) est laissé INTACT ;
 * 3. chaque bloc $$...$$ non encore isolé est mis sur ses propres lignes
 *    entourées de lignes vides — condition nécessaire pour que remark-math
 *    le reconnaisse comme "math flow".
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

/**
 * Convertit \[...\] et \(...\), et enveloppe les environnements
 * \begin{...} NUS dans $$...$$.
 *
 * Scanner caractère par caractère (au lieu d'une regex globale) : les corps
 * de `\[ \]`, `\( \)` et `$$...$$` sont consommés INTÉGRIALEMENT et réémis
 * tels quels — le corps d'un `\begin{aligned}` placé DANS un `\[ \]`
 * multiligne ne peut donc jamais être re-enveloppé (le bug « double $$ »
 * des regex globales). Les sauts de ligne LaTeX `\\[2pt]` ne sont pas
 * confondus avec un délimiteur : un vrai `\[` n'est jamais précédé d'un
 * backslash, alors que le second backslash de `\\[` l'est.
 */
function convertDelimiters(markdown: string): string {
  const out: string[] = [];
  let textBuf = "";

  function flushText() {
    if (textBuf) out.push(wrapNakedEnvs(textBuf));
    textBuf = "";
  }

  let i = 0;
  while (i < markdown.length) {
    // \[ ... \] → $$ ... $$ (bloc affiché).
    if (markdown[i] === "\\" && markdown[i + 1] === "[" && markdown[i - 1] !== "\\") {
      const end = findUnescaped(markdown, i + 2, "\\]");
      if (end !== -1) {
        flushText();
        out.push(`$$${markdown.slice(i + 2, end)}$$`);
        i = end + 2;
        continue;
      }
    }
    // \( ... \) → $ ... $ (en ligne).
    if (markdown[i] === "\\" && markdown[i + 1] === "(") {
      const end = findUnescaped(markdown, i + 2, "\\)");
      if (end !== -1) {
        flushText();
        out.push(`$${markdown.slice(i + 2, end)}$`);
        i = end + 2;
        continue;
      }
    }
    // $$ ... $$ déjà présents : consommé en un bloc (jamais re-enveloppé).
    if (markdown[i] === "$" && markdown[i + 1] === "$") {
      const end = findUnescaped(markdown, i + 2, "$$");
      if (end !== -1) {
        flushText();
        out.push(markdown.slice(i, end + 2));
        i = end + 2;
        continue;
      }
    }
    textBuf += markdown[i];
    i += 1;
  }
  flushText();
  return out.join("");
}

/** Retrouve la prochaine occurrence de `token` à partir de `from`, en
 *  ignorant celle échappée par un backslash immédiatement avant. */
function findUnescaped(hay: string, from: number, token: string): number {
  for (let idx = from; idx + token.length <= hay.length; idx++) {
    let ok = true;
    for (let j = 0; j < token.length; j++) {
      if (hay[idx + j] !== token[j]) {
        ok = false;
        break;
      }
    }
    if (ok && (idx === 0 || hay[idx - 1] !== "\\")) return idx;
  }
  return -1;
}

/** Enveloppe dans $$...$$ les environnements \begin{...}...\end{...} laissés
 *  nus dans un texte DÉJÀ VIDÉ de tout `$$`/`\[ \]`/`\( \)` (le scanner les
 *  a retirés avant de passer ici) : plus aucun risque de double
 *  enveloppement. `\\[2pt]` et `\\ \hline` à l'intérieur du corps sont
 *  conservés tels quels. */
function wrapNakedEnvs(text: string): string {
  return text.replace(
    /\\begin\{(aligned|align\*?|matrix|pmatrix|bmatrix|cases|array)\}([\s\S]*?)\\end\{\1\}/g,
    (match, env: string, body: string) => `$$\n\\begin{${env}}${body}\\end{${env}}\n$$`
  );
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
  // convertDelimiters couvre déjà toutes les formes (\[ \], \( \), $$
  // présents, \begin{...} nus) SANS jamais rescanner un corps de bloc déjà
  // délimité : une seule passe d'isolation suffit ensuite pour remettre sur
  // des lignes dédiées les $$ créés ça-et-là dans le texte.
  return isolateDisplayMath(convertDelimiters(markdown));
}
