import { EpreuveListItem, SubscriptionOut } from "../api/types";

export type AccesStatus = "gratuit" | "ouvert" | "payant";

/**
 * Détermine le statut d'accès d'une épreuve pour l'utilisateur courant —
 * troisième statut ajouté à côté de "gratuit"/"payant" existants :
 * "ouvert" (déjà débloquée via un abonnement actif, mais pas gratuite en
 * elle-même). Recalcule la même logique d'appartenance que
 * `store.has_access` côté backend, mais en TypeScript à partir de la liste
 * déjà chargée des abonnements de l'utilisateur (`GET
 * /api/subscriptions/mine`) — évite un aller-retour réseau par carte du
 * catalogue.
 *
 * Depuis la refonte multi-classes : un abonnement couvre une épreuve si
 * évaluation/classe correspondent (ou joker "ALL") ET que sa série fait
 * partie des séries de l'épreuve ET matière/année (ou "ALL"), ou s'il
 * cible exactement cette épreuve.
 */
export function computeAccessStatus(
  epreuve: EpreuveListItem,
  subscriptions: SubscriptionOut[]
): AccesStatus {
  if (epreuve.gratuit) return "gratuit";

  const now = Date.now();
  const couverte = subscriptions.some((s) => {
    if (s.statut !== "active") return false;
    if (new Date(s.end_date).getTime() < now) return false;
    // Un abonnement d'« épreuve précise » ne couvre QUE cette épreuve
    // (miroir exact de store.has_access côté backend).
    if (s.epreuve_id) return s.epreuve_id === epreuve.id;
    if (s.evaluation !== "ALL" && s.evaluation !== epreuve.evaluation) return false;
    if (s.classe !== "ALL" && s.classe !== epreuve.classe) return false;
    if (!epreuve.filieres.includes(s.filiere)) return false;
    if (s.matiere !== "ALL" && s.matiere !== epreuve.matiere) return false;
    if (s.annee !== "ALL" && s.annee !== epreuve.annee) return false;
    return true;
  });

  return couverte ? "ouvert" : "payant";
}
