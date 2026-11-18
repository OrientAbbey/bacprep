/**
 * Contexte partagé entre les panneaux admin et l'assistant global : chaque
 * panneau « publie » l'état courant de son formulaire (ce que l'admin voit et
 * a commencé à remplir) ainsi que le schéma de ses champs éditables, et
 * enregistre un « appliqueur » qui permet à l'agent de modifier ces champs
 * localement (brouillon, sans écriture serveur).
 *
 * Pas d'état React ici : le panneau publie en continu, l'assistant lit au
 * moment de l'envoi, puis applique les éditions reçues via l'appliqueur.
 */
export type ContexteOnglet = Record<string, unknown>;

export interface ChampAdmin {
  cle: string;
  libelle: string;
  type?: string;
  options?: string[];
}

interface EntreeOnglet {
  contexte: ContexteOnglet;
  champs: ChampAdmin[];
  appliqueur?: (editions: Record<string, unknown>[]) => void;
  ouvreur?: (cible: string) => boolean;
}

const contexteParOnglet = new Map<string, EntreeOnglet>();

export function publierContexteAdmin(
  onglet: string,
  contexte: ContexteOnglet,
  champs: ChampAdmin[] = [],
): void {
  const precedent = contexteParOnglet.get(onglet);
  contexteParOnglet.set(onglet, {
    contexte,
    champs,
    appliqueur: precedent?.appliqueur,
    ouvreur: precedent?.ouvreur,
  });
}

export function lireContexteAdmin(onglet: string): ContexteOnglet | null {
  return contexteParOnglet.get(onglet)?.contexte ?? null;
}

export function lireChampsAdmin(onglet: string): ChampAdmin[] {
  return contexteParOnglet.get(onglet)?.champs ?? [];
}

/** Enregistre la fonction qui applique les éditions de l'agent au formulaire du panneau. */
export function enregistrerAppliqueurAdmin(
  onglet: string,
  appliqueur: (editions: Record<string, unknown>[]) => void,
): () => void {
  const precedent = contexteParOnglet.get(onglet);
  contexteParOnglet.set(onglet, {
    contexte: precedent?.contexte ?? {},
    champs: precedent?.champs ?? [],
    appliqueur,
    ouvreur: precedent?.ouvreur,
  });
  return () => {
    const actuel = contexteParOnglet.get(onglet);
    if (actuel?.appliqueur === appliqueur) actuel.appliqueur = undefined;
  };
}

/** Enregistre la fonction qui ouvre un formulaire (« Nouvel exercice »…). */
export function enregistrerOuvreurAdmin(
  onglet: string,
  ouvreur: (cible: string) => boolean,
): () => void {
  const precedent = contexteParOnglet.get(onglet);
  contexteParOnglet.set(onglet, {
    contexte: precedent?.contexte ?? {},
    champs: precedent?.champs ?? [],
    appliqueur: precedent?.appliqueur,
    ouvreur,
  });
  return () => {
    const actuel = contexteParOnglet.get(onglet);
    if (actuel?.ouvreur === ouvreur) actuel.ouvreur = undefined;
  };
}

/** Ouvre le formulaire demandé par l'agent. Renvoie false si la cible est inconnue. */
export function ouvrirFormulaireAdmin(onglet: string, cible: string): boolean {
  return contexteParOnglet.get(onglet)?.ouvreur?.(cible) ?? false;
}

/** Applique les éditions reçues de l'agent au panneau courant, si elle existe. */
/** Applique des champs bruts (tels que reçus dans un événement SSE `edition`). */
export function appliquerChampsAdmin(
  onglet: string,
  champsList: Record<string, unknown>[],
): boolean {
  return appliquerEditionsAdmin(onglet, champsList.map((champs) => ({ champs })));
}

export function appliquerEditionsAdmin(
  onglet: string,
  editions: Record<string, unknown>[],
): boolean {
  const appliqueur = contexteParOnglet.get(onglet)?.appliqueur;
  if (!appliqueur || editions.length === 0) return false;
  appliqueur(editions);
  return true;
}

export function effacerContexteAdmin(onglet?: string): void {
  if (onglet === undefined) contexteParOnglet.clear();
  else contexteParOnglet.delete(onglet);
}
