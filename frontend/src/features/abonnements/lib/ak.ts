import { t } from "../../../i18n";

/** Mouvement du journal AK, tel que `/api/me/profil` l'expose. `montant` est
 * SIGNÉ (positif = crédit, négatif = débit) ; `motif` est une clé technique
 * du serveur, jamais affichée telle quelle. */
/** Mouvement de la monnaie interne AK : montant signé, motif et détails. */
export interface MouvementAK {
  id: string;
  montant: number;
  motif: string;
  details: Record<string, unknown>;
  date: string;
}

// Règles du serveur (backend/app/domains/abonnements/ak.py) dupliquées ICI
// pour afficher le gain de la prochaine connexion sans rappeler l'API. Toute
// modification du barème doit être faite des deux côtés — les tests du
// frontend couvrent la table de vérité, ceux du backend la leur.
/** Gain AK pour les trois premiers jours d'une série de connexions. */
export const GAIN_JOURS_1_3 = 3;
/** Gain AK pour les jours 4 à 6 d'une série de connexions. */
export const GAIN_JOURS_4_6 = 7;
/** Gain AK à partir du septième jour d'une série. */
export const GAIN_JOURS_7_PLUS = 10;
/** Écart entre deux gains à partir duquel la série repart au jour 1 :
 * 1 jour = connexions consécutives, 2 jours = un jour manqué. */
export const RESET_APRES_JOURS = 2;

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
/** Date du jour au format UTC AAAA-MM-JJ (clé de comparaison des séries). */
export function jourUTC(maintenant: Date = new Date()): string {
  return maintenant.toISOString().slice(0, 10);
}

/** Gain crédité à la PROCHAINE connexion, compte tenu de la série en cours.
 *
 * Un seul jour manqué (écart ≥ 2 jours) remet la série au jour 1 côté serveur
 * ; le prochain gain annoncé est donc celui du jour 1. Tant que les connexions
 * restent consécutives, le palier 7+ continue de rapporter 10 AK.
 */
export function gainProchaineConnexion(
  serie: number,
  dernierJour: string | null,
  jour: string = jourUTC(),
): number {
  if (!dernierJour) return GAIN_JOURS_1_3;
  const ecart = (Date.parse(jour) - Date.parse(dernierJour)) / 86_400_000;
  // Date illisible, dans le futur ou jour manqué : la série repart au jour 1.
  if (!Number.isFinite(ecart) || ecart < 0 || ecart >= RESET_APRES_JOURS) return GAIN_JOURS_1_3;
  return gainPourSerie(Math.max(serie, 0) + 1);
}

/** Phrase lisible d'un motif technique. Les motifs sont produits par
 * `domains/abonnements/ak.py` (`connexion_j1` … `connexion_j7plus`, `achat:<plan_id>`) et
 * par les crédits manuels (`ajustement_admin`) ; un motif inconnu (nouvelle
 * règle serveur) s'affiche tel quel plutôt que de disparaître. */
/** Libellé lisible d'un motif de mouvement AK (connexion, achat, ajustement admin). */
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
