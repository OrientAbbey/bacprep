/** Onglets de la console d'administration.
 *
 * Ce module ne contient QUE la liste (aucun composant) : l'aide de la console
 * et son test de couverture peuvent la lire sans charger les panneaux.
 */
export type Onglet =
  | "epreuves"
  | "import"
  | "sauvegardes"
  | "utilisateurs"
  | "parametres"
  | "formules"
  | "gabarits"
  | "calendrier"
  | "journal"
  | "signalements"
  | "notifications";

/** Les onglets, regroupés en trois familles (navigation latérale sur écran large). */
export const GROUPES: { titre: string; ids: Onglet[] }[] = [
  { titre: "Contenu", ids: ["epreuves", "import", "formules", "gabarits", "calendrier"] },
  { titre: "Communauté", ids: ["utilisateurs", "signalements", "notifications"] },
  { titre: "Système", ids: ["parametres", "sauvegardes", "journal"] },
];

export const ONGLETS: Onglet[] = GROUPES.flatMap((g) => g.ids);
