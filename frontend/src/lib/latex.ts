/**
 * Normalise des variantes de délimiteurs LaTeX que les modèles produisent
 * parfois malgré l'instruction de n'utiliser que $...$/$$...$$ (voir
 * core/assistant.py, `_build_prompt`) — `remark-math` (utilisé par
 * MarkdownContent) ne reconnaît QUE la syntaxe dollar, donc \( \), \[ \]
 * ou un \begin{...} nu ne seraient sinon jamais rendus et resteraient
 * affichés comme du texte brut illisible.
 *
 * Best-effort, pas un vrai parseur LaTeX : suffisant pour les cas usuels
 * (bloc affiché, formule en ligne, environnement aligned/matrix nu) sans
 * viser une couverture exhaustive de toute la syntaxe LaTeX possible.
 */
export function normalizeLatexDelimiters(markdown: string): string {
  let out = markdown;

  // \[ ... \] (bloc affiché) -> $$ ... $$
  out = out.replace(/\\\[([\s\S]*?)\\\]/g, (_match, inner) => `$$${inner}$$`);

  // \( ... \) (en ligne) -> $ ... $
  out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_match, inner) => `$${inner}$`);

  // Un environnement \begin{...}...\end{...} laissé nu (pas déjà entre
  // signes dollar juste avant/après) est enveloppé dans $$ ... $$.
  out = out.replace(
    /(\$\$?)?\\begin\{(aligned|align\*?|matrix|pmatrix|bmatrix|cases|array)\}([\s\S]*?)\\end\{\2\}(\$\$?)?/g,
    (match, before, env, body, after) => {
      if (before && after) return match; // déjà correctement délimité
      return `$$\\begin{${env}}${body}\\end{${env}}$$`;
    }
  );

  // Isole tout bloc $$...$$ sur ses propres lignes, entourées de lignes
  // vides — condition nécessaire pour que `remark-math` le reconnaisse
  // comme un bloc de formule ("math flow", au même titre qu'un bloc de
  // code avec des ```). `remark-math` traite $$...$$ comme un CONSTRUIT DE
  // BLOC (à la manière d'un bloc de code clôturé), pas comme un délimiteur
  // utilisable au milieu d'un paragraphe : un modèle qui écrit
  // "Donc $$x=1$$ car..." ou qui place la formule au milieu d'une phrase
  // sans saut de ligne produit un bloc que le moteur ne reconnaît PAS comme
  // formule et laisse tel quel en texte brut (backslashes compris) — ce
  // qui correspond exactement au bug observé. On force donc chaque
  // occurrence de $$...$$, où qu'elle apparaisse dans le texte, à être
  // entourée de lignes vides, quelle que soit la façon dont le modèle l'a
  // formatée à l'origine.
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_match, inner) => `\n\n$$\n${inner.trim()}\n$$\n\n`);

  return out;
}
