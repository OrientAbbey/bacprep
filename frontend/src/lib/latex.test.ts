import { describe, expect, it } from "vitest";
import { normalizeDisplayMathDelimitersPreservingOffsets, normalizeLatexDelimiters } from "./latex";

describe("normalizeLatexDelimiters", () => {
  it("normalise une formule LaTeX complétée par fragments SSE sans perdre le contenu", () => {
    const fragments = [
      "### 2. Acide 2-aminohexanoïque\n\n\\[\n\\begin{array}{cccccccc}\n&&NH_2&&&&&",
      "\\\\\n&&|&&&&&\\\\\nCH_3&-&CH_2&-&CH_2&-&CH_2&-CH_2-CH-C(=O)-OH\\\\\n",
      "&&&&&&&&\n\\end{array}\n\\]",
    ];
    let streamed = "";
    for (const fragment of fragments) {
      streamed += fragment;
      // Le composant chat réapplique cette normalisation après chaque mise à
      // jour d'état ; les préfixes incomplets ne doivent jamais lever d'erreur.
      expect(() => normalizeLatexDelimiters(streamed)).not.toThrow();
    }

    const normalized = normalizeLatexDelimiters(streamed);
    expect(normalized).toContain("$$\n\\begin{array}{cccccccc}");
    expect(normalized).toContain("&&NH_2&&&&&\\\\");
    expect(normalized).toContain("CH_3&-&CH_2&-&CH_2&-&CH_2&-CH_2-CH-C(=O)-OH");
    expect(normalized).toContain("\\end{array}\n$$");
    expect(normalized).not.toContain("\\[");
  });

  it("isole une formule $$ au milieu d'un paragraphe", () => {
    const out = normalizeLatexDelimiters("Donc $$x=1$$ car a>b.");
    expect(out).toContain("$$\nx=1\n$$");
    // Des lignes vides entourent le bloc isolé
    expect(out).toMatch(/\n\n\$\$\nx=1\n\$\$\n\n/);
  });

  it("sépare plusieurs blocs $$ sur une même ligne", () => {
    const out = normalizeLatexDelimiters("A $$a$$ puis $$b$$ fin.");
    expect((out.match(/\$\$/g) || []).length).toBe(4);
    expect(out).toContain("$$\na\n$$");
    expect(out).toContain("$$\nb\n$$");
  });

  it("gère un bloc $$ à cheval sur plusieurs lignes", () => {
    const out = normalizeLatexDelimiters("Avant $$x =\n1 + 2$$ après.");
    expect(out).toContain("$$\nx =\n1 + 2\n$$");
    expect(out).toContain("après.");
  });

  it("laisse les blocs de code fencés intacts", () => {
    const src = "```md\n$$x=1$$\n```\nEt $$y=2$$ ici.";
    const out = normalizeLatexDelimiters(src);
    expect(out).toContain("```md\n$$x=1$$\n```");
    expect(out).toContain("$$\ny=2\n$$");
  });

  it("ne touche pas au $ inline ni aux \\$ échappés", () => {
    const out = normalizeLatexDelimiters("Coût \\$5 et $a+b$ inline.");
    expect(out).not.toContain("$$");
    expect(out).toContain("$a+b$");
  });

  it("convertit \\[...\\] en bloc $$ isolé", () => {
    const out = normalizeLatexDelimiters("Résultat \\[x^2\\] fini.");
    expect(out).not.toContain("\\[");
    expect(out).toContain("$$\nx^2\n$$");
  });

  it("convertit \\(...\\) en $ inline (non isolé)", () => {
    const out = normalizeLatexDelimiters("Valeur \\(x\\) en ligne.");
    expect(out).not.toContain("\\(");
    expect(out).toContain("$x$");
  });

  it("enveloppe un environnement \\begin nu dans $$", () => {
    const out = normalizeLatexDelimiters("Matrice : \\begin{pmatrix}a\\end{pmatrix} voilà.");
    expect(out).toMatch(/\$\$\n\\begin\{pmatrix\}a\\end\{pmatrix\}\n\$\$/);
  });

  it("ne casse pas un bloc $$ déjà bien isolé", () => {
    const src = "Texte.\n\n$$\nx=1\n$$\n\nSuite.";
    const out = normalizeLatexDelimiters(src);
    expect(out).toContain("$$\nx=1\n$$");
  });

  it("ne re-enveloppe pas un environnement déjà entre $$ sur ses propres lignes", () => {
    // Cas réel : cases/aligné sur ses propres lignes entre $$...$$. Sans le
    // lookbehind (?<!\$\$\s), l'environnement était re-wrapped et produisait
    // un double $$...$$ ($$\n$$\n...\n$$\n$$) que remark-math ne rendait pas.
    const src = "$$\n\\begin{cases}\n0 & \\text{si } x\\ge 0\\\\[2pt]\n1 & \\text{sinon}\n\\end{cases}\n$$";
    expect(src.match(/\$\$/g) || []).toHaveLength(2);
    const out = normalizeLatexDelimiters(src);
    expect(out.match(/\$\$/g) || []).toHaveLength(2);
    expect(out).toContain("\\begin{cases}");
    expect(out).toContain("\\\\[2pt]");
    expect(out).not.toContain("$$\n$$\n");
  });

  it("enveloppe une fois un environnement nu contenant des sauts \\\\[2pt]", () => {
    // Cas réel : aligned nu finissant ses lignes par \\[2pt]. Le lookbehind
    // (?<!\\) empêche de convertir ce « \[ » (et de chercher un « \] » absent)
    // comme un vrai délimiteur d'affichage ; l'environnement est ensuite
    // enveloppé UNE seule fois dans $$...$$.
    const src = "\\begin{aligned}\nu_1 &= 1\\\\[2pt]\nu_2 &= 2\n\\end{aligned}";
const out = normalizeLatexDelimiters(src);
    // Une seule enveloppe $$...$$, \\[2pt] intact (jamais converti en \[...\]).
    expect(out).toBe(
      "$$\n\\begin{aligned}\nu_1 &= 1\\\\[2pt]\nu_2 &= 2\n\\end{aligned}\n$$\n"
    );
  });

  it("ne convertit pas \\[2pt] isolé hors environnement", () => {
    // Même protection en texte simple : \\[2pt] n'est jamais un délimiteur.
    const src = "Valeur moyenne : \\[2pt].";
    const out = normalizeLatexDelimiters(src);
    expect(out).toContain("\\[2pt]");
    expect(out.match(/\$\$/g) || []).toHaveLength(0);
  });

  it("restitue un $$ jamais refermé sans perdre le contenu", () => {
    const out = normalizeLatexDelimiters("Début $$x=1\nsuite sans fin.");
    expect(out).toContain("x=1");
  });

  it("ne re-enveloppe pas un \\begin{array} MULTILIGNE servi DANS \\[ \\]", () => {
    // Bug corrigé : une regex globale convertissait \\[ \\] puis re-wrapait
    // l'environnement du corps multiligne → double $$...$$ illisible
    // ($$$$\n\\begin...), formules jamais rendues par remark-math.
    const src = "Donner le tableau de variation :\\[\\begin{array}{c|cccc}\nx&0&1&2&3\\\\\\hline\nf'(x)&+&0&-&+\n\\end{array}\\]";
    const out = normalizeLatexDelimiters(src);
    // Une seule enveloppe $$ ; le « \\[ » de fin de ligne n'est PAS un délimiteur.
    expect(out.match(/\$\$/g) || []).toHaveLength(2);
    expect(out).toContain("\\begin{array}{c|cccc}");
    expect(out).toContain("\\\\\\hline");
    expect(out).not.toContain("$$$$");
    expect(out).toContain("$$\n\\begin{array}{c|cccc}");
  });

  it("convertit un \\begin{aligned} nu DANS un bloc \\[ \\] sans double enveloppe", () => {
    const src = "\\[\\begin{aligned}\nu_1 &= 1\\\\[2pt]\nu_2 &= 2\n\\end{aligned}\\]";
    const out = normalizeLatexDelimiters(src);
    expect(out.match(/\$\$/g) || []).toHaveLength(2);
    expect(out).not.toContain("$$$$");
    expect(out).toContain("\\\\[2pt]");
    expect(out).toMatch(/^\$\$\n\\begin\{aligned\}/);
  });

  it("enveloppe un \\begin{array} nu en table (présence de \\\\ \\hline)", () => {
    const src = "\\begin{array}{c|ccc}\na&b&c\\\\\\hline\nd&e&f\n\\end{array}";
    const out = normalizeLatexDelimiters(src);
    expect(out.match(/\$\$/g) || []).toHaveLength(2);
    expect(out).toContain("\\\\\\hline");
  });

  it("gère \\', \\searrow, \\nearrow, \\tfrac32 et \\text{variation sans les briser", () => {
    // Extrait du style « tableau de variation » renvoyé par l'assistant :
    // le fléchage de la mmachine à états ne doit ni re-wraper ni décaler.
    const src = "\\[\\begin{array}{c|ccccccc}\nx&-\\infty&&&+\\infty\\\\\\hline\nf'(x)&&-&0&+\\\\\\hline\nf&\\nearrow&&\\searrow&&\\nearrow\n\\end{array}\\]";
    const out = normalizeLatexDelimiters(src);
    expect(out.match(/\$\$/g) || []).toHaveLength(2);
    expect(out).toContain("\\nearrow");
    expect(out).toContain("\\searrow");
    expect(out).not.toContain("$$$$");
  });

  it("rend \\tfrac32 et \\text{variation tels quels dans un corps de bloc", () => {
    const src = "\\[\\tfrac32\\text{ variation sur }[0;2]\\]";
    const out = normalizeLatexDelimiters(src);
    expect(out).toContain("\\tfrac32");
    expect(out).toContain("\\text{ variation sur }[0;2]");
    expect(out.match(/\$\$/g) || []).toHaveLength(2);
  });
});

describe("normalizeDisplayMathDelimitersPreservingOffsets", () => {
  it("convertit le bloc array utilisé dans l'aperçu admin sans toucher à sa structure", () => {
    const src = String.raw`\[
\begin{array}{cccccccc}
&&NH_2&&&&&\\
&&|&&&&&\\
CH_3&-&CH_2&-&CH_2&-&CH_2&-CH_2-CH-C(=O)-OH\\
&&&&&&&&
\end{array}
\]`;
    const out = normalizeDisplayMathDelimitersPreservingOffsets(src);

    expect(out).toHaveLength(src.length);
    expect(out.startsWith("$$\n\\begin{array}{cccccccc}")).toBe(true);
    expect(out.endsWith("\\end{array}\n$$")).toBe(true);
    expect(out).toContain("&&NH_2&&&&&");
    expect(out).toContain("CH_3&-&CH_2&-&CH_2&-&CH_2&-CH_2-CH-C(=O)-OH");
  });

  it("convertit un array chimique sans décaler les offsets source", () => {
    const src = String.raw`\[
\begin{array}{ccccccccccccc}
&&&&&&NH_2\\
&&&&&&|\\
CH_3&-&CH_2&-&CH_2&-&CH_2&-&CH_2&-&CH&-&C(=O)-OH
\end{array}
\]`;
    const out = normalizeDisplayMathDelimitersPreservingOffsets(src);

    expect(out).toHaveLength(src.length);
    expect(out).toContain("$$\n\\begin{array}{ccccccccccccc}");
    expect(out).toContain("\\end{array}\n$$");
    expect(out).toContain("&&&&&&NH_2\\\\");
    expect(out).toContain("CH_3&-&CH_2&-&CH_2&-&CH_2&-&CH_2&-&CH&-&C(=O)-OH");
  });

  it("ne modifie ni les blocs de code ni les sauts de ligne LaTeX \\[2pt]", () => {
    const src = "```latex\n\\[\nx\\\\[2pt]\n\\]\n```\n\\[\nx=1\n\\]";
    const out = normalizeDisplayMathDelimitersPreservingOffsets(src);

    expect(out).toContain("```latex\n\\[\nx\\\\[2pt]\n\\]\n```");
    expect(out.endsWith("$$\nx=1\n$$")).toBe(true);
    expect(out).toHaveLength(src.length);
  });

  it("laisse intacts les délimiteurs non appariés", () => {
    const src = "\\[\nx=1";
    expect(normalizeDisplayMathDelimitersPreservingOffsets(src)).toBe(src);
  });

  it("ne touche pas aux délimiteurs dans un bloc $$ existant", () => {
    const src = "$$\n\\[\nx=1\n\\]\n$$";
    expect(normalizeDisplayMathDelimitersPreservingOffsets(src)).toBe(src);
  });
});
