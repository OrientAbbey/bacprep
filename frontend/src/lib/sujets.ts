import { t } from "../i18n";

/** Mode d'affichage d'une épreuve à plusieurs sujets : un sujet à la fois (« page par page »)
 * ou tous les sujets à la suite (« toutes les pages »). Préférence mémorisée sur l'appareil. */
export type AffichageSujets = "page" | "tout";
const CLE = "bacprep-affichage-sujets";

export function affichageInitial(): AffichageSujets {
  try {
    return localStorage.getItem(CLE) === "tout" ? "tout" : "page";
  } catch {
    return "page";
  }
}
export function memoriserAffichage(a: AffichageSujets): void {
  try {
    localStorage.setItem(CLE, a);
  } catch {
    /* préférence non mémorisée */
  }
}

interface Sujet {
  contenu_markdown: string;
  corrige_markdown: string;
}

/** Les sujets (ou leurs corrigés) mis bout à bout en UN seul Markdown : chaque partie porte un
 * titre « Sujet N » / « Corrigé du sujet N » (sert d'ancre de navigation) et reste liée à son
 * texte source, ce qui garde la sélection → note / question à l'assistant exacte. */
export function assemblerContenu(sujets: Sujet[], cible: "sujet" | "corrige"): string {
  const parties: string[] = [];
  sujets.forEach((s, i) => {
    const texte = (cible === "sujet" ? s.contenu_markdown : s.corrige_markdown)?.trim();
    if (!texte) return;
    const titre = cible === "sujet" ? t("Sujet {n}", { n: i + 1 }) : t("Corrigé du sujet {n}", { n: i + 1 });
    parties.push(`## ${titre}\n\n${texte}`);
  });
  return parties.join("\n\n---\n\n");
}

/** Texte à afficher : tous les sujets assemblés en mode « tout » (si plusieurs), sinon le seul sujet actif. */
export function contenuAffiche(
  sujets: Sujet[],
  actif: Sujet | null | undefined,
  cible: "sujet" | "corrige",
  affichage: AffichageSujets
): string {
  if (affichage === "tout" && sujets.length > 1) return assemblerContenu(sujets, cible);
  return (cible === "sujet" ? actif?.contenu_markdown : actif?.corrige_markdown) ?? "";
}
