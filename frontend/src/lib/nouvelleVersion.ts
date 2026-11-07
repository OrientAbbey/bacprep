/** Déploiement de l'application et chunks hachés.
 *
 * Chaque build donne des noms de fichiers hachés (`AdminPage-CDnaR6mQ.js`).
 * Un onglet resté ouvert — ou un `index.html` gardé par le navigateur — peut
 * donc demander un fichier supprimé par le déploiement suivant : le serveur
 * répond 404 et l'import dynamique échoue (« Failed to fetch dynamically
 * imported module »). Un rechargement récupère l'index courant.
 */

const CLE = "bacprep-maj-chunk";
/** Fenêtre anti-boucle : si le rechargement n'a rien réglé (vrai incident),
 * on ne recharge pas en boucle — l'écran d'erreur reste affiché. */
export const DELAI_ANTI_BOUCLE_MS = 15_000;

/** Vrai si l'erreur vient d'un module dynamique introuvable (chunk supprimé
 * par un déploiement), et non d'un vrai bug de rendu. */
export function estChunkPerime(erreur: unknown): boolean {
  const message = erreur instanceof Error ? erreur.message : String(erreur ?? "");
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(message);
}

/** Un rechargement est-il autorisé ? `dernier` = horodatage du précédent
 * rechargement pour ce motif (0 = jamais). */
export function doitRecharger(dernier: number, maintenant: number): boolean {
  return dernier <= 0 || maintenant - dernier >= DELAI_ANTI_BOUCLE_MS;
}

/** Recharge la page pour récupérer la nouvelle version, au plus une fois par
 * fenêtre anti-boucle. `false` si le rechargement a été refusé. */
export function rechargerPourNouvelleVersion(maintenant = Date.now()): boolean {
  let dernier = 0;
  try {
    dernier = Number(sessionStorage.getItem(CLE) ?? 0) || 0;
  } catch {
    // Stockage indisponible (navigation privée stricte) : pas de rechargement
    // automatique, faute de pouvoir garantir l'absence de boucle.
    return false;
  }
  if (!doitRecharger(dernier, maintenant)) return false;
  try {
    sessionStorage.setItem(CLE, String(maintenant));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** Recharge uniquement si l'erreur est un chunk périmé. */
export function rechargerSiChunkPerime(erreur: unknown, maintenant = Date.now()): boolean {
  return estChunkPerime(erreur) && rechargerPourNouvelleVersion(maintenant);
}
