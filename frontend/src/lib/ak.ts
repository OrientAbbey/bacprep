import { t } from "../i18n";

/** Mouvement du journal AK, tel que `/api/me/profil` l'expose. `montant` est
 * SIGNÉ (positif = crédit, négatif = débit) ; `motif` est une clé technique
 * du serveur, jamais affichée telle quelle. */
export interface MouvementAK {
  id: string;
  montant: number;
  motif: string;
  details: Record<string, unknown>;
  date: string;
}

// Règles du serveur (backend/app/core/ak.py) dupliquées ICI pour afficher le
// gain de la prochaine connexion sans rappeler l'API. Toute modification du
// barème doit être faite des deux côtés — les tests du frontend couvrent la
// table de vérité, ceux du backend la leur.
export const GAIN_JOURS_1_3 = 3;
export const GAIN_JOURS_4_6 = 7;
export const GAIN_JOURS_7_PLUS = 10;
export const RESET_APRES_JOURS = 7;

/** Gain en AK pour un jour de série donné (1 = première connexion). */
export function gainPourSerie(serie: number): number {
  if (serie <= 0) return 0;
  if (serie <= 3) return GAIN_JOURS_1_3;
  if (serie <= 6) return GAIN_JOURS_4_6;
  return GAIN_JOURS_7_PLUS;
}

/** Date du jour `AAAA-MM-JJ` en UTC — la même référence que le serveur
 * (`aujourd_hui_utc`) : un élève de Douala ne doit pas voir un gain annoncé
 * puis un autre crédité à cause d'un décalage de fuseau. */
export function jourUTC(maintenant: Date = new Date()): string {
  return maintenant.toISOString().slice(0, 10);
}

/** Gain crédité à la PROCHAINE connexion, compte tenu de la série en cours et
 * de l'éventuelle remise à zéro après `RESET_APRES_JOURS` jours d'absence. */
export function gainProchaineConnexion(
  serie: number,
  dernierJour: string | null,
  jour: string = jourUTC(),
): number {
  if (!dernierJour) return GAIN_JOURS_1_3;
  const ecart = (Date.parse(jour) - Date.parse(dernierJour)) / 86_400_000;
  // Date illisible, dans le futur ou absence trop longue : la série repart de
  // zéro côté serveur, donc le prochain gain est celui du jour 1.
  if (!Number.isFinite(ecart) || ecart < 0 || ecart >= RESET_APRES_JOURS) return GAIN_JOURS_1_3;
  return gainPourSerie(Math.max(serie, 0) + 1);
}

/** Phrase lisible d'un motif technique. Les motifs sont produits par
 * `core/ak.py` (`connexion_j1` … `connexion_j7plus`, `achat:<plan_id>`) et
 * par les crédits manuels (`ajustement_admin`) ; un motif inconnu (nouvelle
 * règle serveur) s'affiche tel quel plutôt que de disparaître. */
export function libelleMouvementAK(motif: string): string {
  if (motif === "ajustement_admin") return t("Ajustement de l'équipe");
  if (motif.startsWith("achat:")) return t("Achat d'un abonnement");
  const connexion = /^connexion_j(\d+)(plus)?$/.exec(motif);
  if (connexion) {
    const jour = connexion[2] ? `${connexion[1]}+` : connexion[1];
    return t("Récompense de connexion — jour {n}", { n: jour });
  }
  return motif;
}
