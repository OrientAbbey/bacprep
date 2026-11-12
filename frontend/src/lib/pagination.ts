/** Lecture « page par page » : une page = une colonne CSS de la largeur de la fenêtre de lecture.
 *  Ce module ne contient que la logique pure (testable sans navigateur) ; le DOM est dans PagedContent. */

export type Affichage = "defilement" | "pages";
const CLE = "bacprep-lecteur-pagine";

/** Écart entre deux colonnes : jamais visible (la fenêtre n'en montre qu'une), mais le pas d'une page en dépend. */
export const ECART_PAGES = 48;

/** Toute valeur inconnue (ou absente) retombe sur le défilement continu, comportement historique. */
export function normaliserAffichage(valeur: unknown): Affichage {
  return valeur === "pages" ? "pages" : "defilement";
}

export function lireAffichage(stockage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): Affichage {
  try {
    return normaliserAffichage(stockage?.getItem(CLE));
  } catch {
    return "defilement"; // stockage indisponible (navigation privée…)
  }
}

export function ecrireAffichage(a: Affichage, stockage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage) {
  try {
    stockage?.setItem(CLE, normaliserAffichage(a));
  } catch {
    /* préférence non mémorisée : sans conséquence */
  }
}

/** Proportions d'une feuille A4 en portrait (297 / 210 = √2). */
export const RATIO_A4 = Math.SQRT2;
/** Largeur minimale d'une feuille : en dessous (fenêtre très basse), des lignes trop courtes — on renonce alors aux
 *  proportions A4 plutôt qu'à la lisibilité. */
export const LARGEUR_MIN_FEUILLE = 360;

export interface Feuille {
  /** 1 = une feuille ; 2 = double page (livre ouvert : deux colonnes séparées par un filet). */
  colonnes: 1 | 2;
  /** Dimensions EXTÉRIEURES de la feuille (marges comprises). */
  largeur: number;
  hauteur: number;
  /** Marge intérieure (px) : la zone de texte est la feuille moins deux marges. */
  marge: number;
}

/** Feuille de lecture pour une zone disponible de `largeurCadre × hauteurCadre` : A4 PORTRAIT (la hauteur de la feuille est
 *  celle de la zone, sa largeur en découle), centrée ; DEUX feuilles côte à côte (double page) quand la zone peut en
 *  porter deux ; sur un écran plus étroit que la feuille (téléphone), elle prend toute la largeur. */
export function dimensionsFeuille(largeurCadre: number, hauteurCadre: number): Feuille {
  if (!(largeurCadre > 0) || !(hauteurCadre > 0)) return { colonnes: 1, largeur: 0, hauteur: 0, marge: 0 };
  const ideale = Math.max(hauteurCadre / RATIO_A4, LARGEUR_MIN_FEUILLE);
  const double = largeurCadre >= 2 * ideale;
  const largeur = double ? 2 * ideale : Math.min(largeurCadre, ideale);
  const parFeuille = largeur / (double ? 2 : 1);
  const marge = Math.round(Math.min(44, Math.max(14, parFeuille * 0.08)));
  return { colonnes: double ? 2 : 1, largeur, hauteur: hauteurCadre, marge };
}

/** Zone de texte (px) à l'intérieur d'une feuille. */
export function zoneTexte(f: Feuille): { largeur: number; hauteur: number } {
  return { largeur: Math.max(0, f.largeur - 2 * f.marge), hauteur: Math.max(0, f.hauteur - 2 * f.marge) };
}

/** Largeur d'une colonne quand une page de `largeurPage` en porte `colonnes` séparées par `ecart`. */
export function largeurColonne(largeurPage: number, colonnes: number, ecart = ECART_PAGES): number {
  return (largeurPage - (colonnes - 1) * ecart) / colonnes;
}

/** Nombre de PAGES à partir de la largeur défilable du flux (n colonnes mesurent n·colonne + (n−1)·écart). Avec deux
 *  colonnes par page, un nombre impair de colonnes laisse la dernière page à moitié vide : elle compte quand même. */
export function nombrePages(largeurDefilable: number, largeurPage: number, ecart = ECART_PAGES, colonnes = 1): number {
  if (!(largeurPage > 0) || !Number.isFinite(largeurDefilable)) return 1;
  const col = largeurColonne(largeurPage, colonnes, ecart);
  const nbColonnes = Math.max(1, Math.round((largeurDefilable + ecart) / (col + ecart)));
  return Math.max(1, Math.ceil(nbColonnes / colonnes));
}

/** Position (px) du dernier point que la fenêtre doit pouvoir atteindre : fin de la dernière page, même incomplète.
 *  Une cale invisible posée là rend la dernière page défilable jusqu'à son numéro (sinon `scrollLeft` serait bridé et
 *  la dernière page, à une seule colonne, s'afficherait décalée sur la précédente). */
export function finDernierePage(pages: number, largeurPage: number, ecart = ECART_PAGES): number {
  return Math.max(0, pages * (largeurPage + ecart) - ecart);
}

/** Ramène un numéro de page (0-based) dans [0, total − 1]. */
export function bornerPage(page: number, total: number): number {
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(0, Math.round(page)), Math.max(0, total - 1));
}

/** Un bloc du Markdown (offset source `start`) et la page où il commence. */
export type ElementPage = { start: number; page: number };

/** Ancre d'une page : de quoi la retrouver après un changement de mise en page (A−/A+, redimensionnement…).
 *  = le premier bloc (dans le texte) qui commence sur la page ; à défaut (page occupée par la suite d'un long
 *  paragraphe), le dernier bloc commencé sur la page précédente la plus proche. `null` si aucun bloc. */
export function ancrePourPage(items: readonly ElementPage[], page: number): number | null {
  const ici = items.filter((e) => e.page === page);
  if (ici.length) return Math.min(...ici.map((e) => e.start));
  const avant = items.filter((e) => e.page < page);
  if (!avant.length) return items.length ? Math.min(...items.map((e) => e.start)) : null;
  const derniere = Math.max(...avant.map((e) => e.page));
  return Math.max(...avant.filter((e) => e.page === derniere).map((e) => e.start));
}

/** Page (0-based) où se trouve maintenant le bloc d'ancre `ancre` ; si ce bloc n'existe plus, celui qui le précède. */
export function pagePourAncre(items: readonly ElementPage[], ancre: number): number {
  const exact = items.filter((e) => e.start === ancre);
  if (exact.length) return Math.min(...exact.map((e) => e.page));
  const avant = items.filter((e) => e.start < ancre);
  if (!avant.length) return 0;
  const proche = Math.max(...avant.map((e) => e.start));
  return Math.min(...avant.filter((e) => e.start === proche).map((e) => e.page));
}

/** Balayage tactile : +1 = page suivante (doigt vers la gauche), −1 = précédente, 0 = trop court ou trop vertical. */
export function directionBalayage(dx: number, dy: number, seuil = 50): -1 | 0 | 1 {
  if (Math.abs(dx) < seuil || Math.abs(dx) < 1.5 * Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

export type ActionPage = "suivante" | "precedente" | "premiere" | "derniere";

/** Touche → action. Maj/Ctrl/Alt/Méta sont laissés au navigateur (Maj+flèches = sélection au clavier). */
export function actionClavier(e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): ActionPage | null {
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case "ArrowRight":
    case "PageDown":
      return "suivante";
    case "ArrowLeft":
    case "PageUp":
      return "precedente";
    case "Home":
      return "premiere";
    case "End":
      return "derniere";
    default:
      return null;
  }
}
