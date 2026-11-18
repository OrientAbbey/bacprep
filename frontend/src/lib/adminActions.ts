/** Actions proposées par l'assistant du back-office : blocs ```action {json}``` à
 * confirmer par l'admin avant exécution (POST /api/admin/assistant/execute). */
export interface ActionProposee {
  outil: string;
  args: Record<string, unknown>;
}

export const LIBELLES_OUTILS: Record<string, string> = {
  signalement_resoudre: "Marquer un signalement comme résolu",
  utilisateur_bannir: "Bannir un élève",
  utilisateur_debannir: "Débannir un élève",
  plan_creer: "Créer une formule d'abonnement",
  plan_modifier: "Modifier une formule d'abonnement",
  evenement_creer: "Ajouter un événement au calendrier",
  evenement_modifier: "Modifier un événement du calendrier",
  notification_creer: "Créer une notification",
  notification_modifier: "Modifier une notification",
  notification_basculer: "Activer/désactiver une notification",
  option_referentiel_ajouter: "Ajouter une option au référentiel",
  option_referentiel_modifier: "Modifier une option du référentiel",
  epreuve_creer: "Créer une épreuve",
  epreuve_modifier: "Modifier une épreuve",
  epreuve_publier: "Publier une épreuve",
  epreuve_retirer: "Retirer une épreuve du catalogue",
  partie_creer: "Créer une partie dans la Banque",
  partie_modifier: "Modifier une partie de la Banque",
  exercice_creer: "Créer un exercice dans la Banque",
  exercice_modifier: "Modifier un exercice de la Banque",
  classe_meta_definir: "Configurer une classe de la Banque",
  gabarit_valider: "Valider un gabarit",
  gabarit_signalement_resoudre: "Résoudre un signalement de gabarit",
  sauvegarde_lancer: "Lancer une sauvegarde",
};

const BLOC = /```action[ \t]*\r?\n?([\s\S]*?)```/g;

/** Sépare le texte affichable des actions proposées ; un bloc JSON invalide est ignoré. */
export function extraireActions(texte: string): { texte: string; actions: ActionProposee[] } {
  const actions: ActionProposee[] = [];
  const reste = texte.replace(BLOC, (_, json: string) => {
    try {
      const o = JSON.parse(json);
      if (o && typeof o.outil === "string" && (o.args === undefined || (typeof o.args === "object" && o.args !== null && !Array.isArray(o.args)))) {
        actions.push({ outil: o.outil, args: o.args ?? {} });
      }
    } catch {
      /* JSON invalide : rien à proposer */
    }
    return "";
  });
  return { texte: reste.trim(), actions };
}
