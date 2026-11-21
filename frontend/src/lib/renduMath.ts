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
/** Options KaTeX communes aux aperçus : mhchem autorisé, HTML+MathML, pas de HTML de confiance. */
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
/** Charge une seule fois l'extension mhchem de KaTeX (promesse idempotente). */
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
/** Vérifie qu'une formule LaTeX est valide, en mode ligne ou bloc. */
export function verifierFormule(formule: string, bloc: boolean): void {
  katex.renderToString(formule, { ...KATEX_OPTIONS_STRICT, displayMode: bloc });
}

/** Un outil de la barre d'insertion : extrait à sélectionner après insertion. */
export interface OutilFormule {
  libelle: string;
  titre: string;
  extrait: string;
  debut: number;
  fin: number;
}

/** Un groupe de la barre d'insertion de formules (maths, physique, chimie, structures). */
export interface GroupeOutils {
  nom: string;
  outils: OutilFormule[];
}

/** Construit un outil depuis un modèle où `§…§` marque la portion à sélectionner. */
function outil(libelle: string, titre: string, modele: string): OutilFormule {
  const debutMarqueur = modele.indexOf("§");
  const finMarqueur = modele.indexOf("§", debutMarqueur + 1);
  if (debutMarqueur === -1) {
    return { libelle, titre, extrait: modele, debut: modele.length, fin: modele.length };
  }
  if (finMarqueur === -1) {
    const extrait = modele.replace("§", "");
    return { libelle, titre, extrait, debut: debutMarqueur, fin: debutMarqueur };
  }
  const extrait = modele.slice(0, debutMarqueur) + modele.slice(debutMarqueur + 1, finMarqueur) + modele.slice(finMarqueur + 1);
  return { libelle, titre, extrait, debut: debutMarqueur, fin: finMarqueur - 1 };
}

/**
 * Barre d'outils partagée par l'éditeur d'épreuves et celui de la banque.
 * Groupes Maths / Physique / Chimie / Structures : les blocs ```mol``` sont
 * rendus par `MolBlock` (chargement différé de SmilesDrawer, lot 4).
 */
/** Catalogue des outils d'insertion de formules proposés dans les éditeurs admin. */
export const GROUPES_OUTILS: GroupeOutils[] = [
  {
    nom: "Maths",
    outils: [
      outil("u₁", "Indice", "$u_{§1§}$"),
      outil("xⁿ", "Exposant", "$x^{§n§}$"),
      outil("a⁄b", "Fraction", "$\\frac{§a§}{b}$"),
      outil("√", "Racine carrée", "$\\sqrt{§x§}$"),
      outil("ⁿ√", "Racine n-ième", "$\\sqrt[§n§]{x}$"),
      outil("∑", "Somme", "$\\sum_{i=§1§}^{n} i$"),
      outil("∏", "Produit", "$\\prod_{i=§1§}^{n} i$"),
      outil("∫", "Intégrale", "$\\int_{§a§}^{b} f(x)\\,dx$"),
      outil("lim", "Limite", "$\\lim_{x\\to §0§} f(x)$"),
      outil("∂", "Dérivée partielle", "$\\frac{\\partial §f§}{\\partial x}$"),
      outil("( )", "Parenthèses adaptées", "$\\left( §x \\right)$"),
      outil("[ ]", "Crochets adaptés", "$\\left[ §x \\right]$"),
      outil("{ }", "Accolades", "$\\{ §x \\}$"),
      outil("▦", "Matrice 2×2", "$\\begin{pmatrix} §a & b \\\\ c & d \\end{pmatrix}$"),
      outil("⎧", "Système (cases)", "$\\begin{cases} §x+y=1 \\\\ x-y=0 \\end{cases}$"),
      outil("|x|", "Valeur absolue", "$\\left| §x \\right|$"),
      outil("±", "Plus ou moins", "$\\pm §a§$"),
      outil("≤", "Inférieur ou égal", "$§a§ \\leq b$"),
      outil("≥", "Supérieur ou égal", "$§a§ \\geq b$"),
      outil("≈", "Approximativement", "$§a§ \\approx b$"),
      outil("∈", "Appartient à", "$§x§ \\in E$"),
      outil("∞", "Infini", "$\\infty§§$"),
      outil("α", "Alpha", "$\\alpha§§$"),
      outil("β", "Beta", "$\\beta§§$"),
      outil("γ", "Gamma", "$\\gamma§§$"),
      outil("θ", "Theta", "$\\theta§§$"),
      outil("λ", "Lambda", "$\\lambda§§$"),
      outil("μ", "Mu", "$\\mu§§$"),
      outil("π", "Pi", "$\\pi§§$"),
      outil("σ", "Sigma", "$\\sigma§§$"),
      outil("Ω", "Omega", "$\\Omega§§$"),
      outil("→", "Flèche", "$\\to§§$"),
      outil("⟹", "Implique", "$\\implies§§$"),
    ],
  },
  {
    nom: "Physique",
    outils: [
      outil("vect", "Vecteur", "$\\vec{§F§}$"),
      outil("Δ", "Variation", "$\\Delta §x§$"),
      outil("ω", "Pulsation", "$\\omega§§$"),
      outil("ħ", "Constante de Planck réduite", "$\\hbar§§$"),
      outil("ρ", "Masse volumique", "$\\rho§§$"),
      outil("φ", "Phi", "$\\phi§§$"),
      outil("E=mc²", "Équivalence masse-énergie", "$E=mc^2§§$"),
      outil("F=ma", "Loi de Newton", "$F=ma§§$"),
      outil("U=RI", "Loi d'Ohm", "$U=RI§§$"),
      outil("½mv²", "Énergie cinétique", "$E=\\frac{1}{2}mv^2§§$"),
      outil("u", "Unité physique", "$\\pu{§123 kJ§}$"),
      outil("u₂", "Unité en notation scientifique", "$\\pu{§1.2e3§ kJ}$"),
      outil("u⁄", "Unité avec division", "$\\pu{§123 kJ//mol§}$"),
    ],
  },
  {
    nom: "Chimie",
    outils: [
      outil("H₂O", "Formule moléculaire", "$\\ce{§H2O§}$"),
      outil("SO₄²⁻", "Ion / charge", "$\\ce{§SO4^2-§}$"),
      outil("Na⁺", "Ion simple", "$\\ce{§Na+§}$"),
      outil("isotope", "Isotope", "$\\ce{§^{227}_{90}Th+§}$"),
      outil("2 H₂O", "Coefficient stœchiométrique", "$\\ce{§2 H2O§}$"),
      outil("semi-dév", "Formule semi-développée", "$\\ce{§CH3-CH2-OH§}$"),
      outil("réaction", "Équation de réaction", "$\\ce{§CO2 + C -> 2 CO§}$"),
      outil("état", "État physique", "$\\ce{§H2O(l)§}$"),
      outil("flèche", "Flèche annotée", "$\\ce{§A ->[I-] B§}$"),
      outil("g/mol", "Unité molaire", "$\\pu{§g.mol-1§}$"),
    ],
  },
  {
    nom: "Structures",
    outils: [
      outil("🧪", "Structure topologique (SMILES, rendu 2D)", "\n```mol topologique\n§CCO éthanol§\n```\n"),
      outil("🧪↔", "Structure développée (SMILES, rendu 2D avec tous les carbones)", "\n```mol developpee\n§CCO éthanol§\n```\n"),
      // SmilesDrawer dessine en 2D et gère la stéréochimie de Cram (coins/silicons
      // stéréochimiques SMILES) ; il ne produit PAS de vue 3D rotative. La vraie 3D
      // demanderait un viewer moléculaire dédié (3Dmol.js) et des coordonnées 3D.
      outil("🧪◐", "Structure de Cram — stéréochimie 2D (la vue 3D n'est pas prise en charge)", "\n```mol cram\n§C[C@H](O)Cl chlorobutane§\n```\n"),
    ],
  },
];
