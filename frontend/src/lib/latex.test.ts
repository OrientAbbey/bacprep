import { describe, expect, it } from "vitest";
import { normalizeLatexDelimiters } from "./latex";

describe("normalizeLatexDelimiters", () => {
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

  it("restitue un $$ jamais refermé sans perdre le contenu", () => {
    const out = normalizeLatexDelimiters("Début $$x=1\nsuite sans fin.");
    expect(out).toContain("x=1");
  });
});
