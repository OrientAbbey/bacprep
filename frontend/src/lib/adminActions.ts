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
  notification_creer: "Créer une notification",
  option_referentiel_ajouter: "Ajouter une option au référentiel",
  epreuve_publier: "Publier une épreuve",
  epreuve_retirer: "Retirer une épreuve du catalogue",
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
