/** Détection de l'installation PWA et de la plateforme, sans effet de bord.

Ces fonctions pures sont volontairement séparées du composant d'interface pour
être testables : le comportement « ne pas réclamer d'installation après un refus »
est une règle produit, pas un détail de rendu.
 */

/** Fenêtre pendant laquelle on ne réaffiche pas la proposition après un refus. */
export const DELAI_REFUS_JOURS = 30;

/** Vrai quand la page tourne déjà en mode application installée (PWA standalone). */
export function estDejaInstallee(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(display-mode: standalone)").matches;
}

/** iPhone / iPad / iPod (ou iPad récent se déclarant comme Mac tactile). */
export function estIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/.test(ua) || iPadOS;
}

/** Safari sur iOS : seul navigateur qui propose « Sur l'écran d'accueil ». */
export function estIOSafari(): boolean {
  if (!estIOS()) return false;
  const ua = navigator.userAgent;
  return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

/** Une proposition peut-elle être faite ? `dateRefus` est une date ISO ou null. */
export function peutProposerInstallation(
  dateRefus: string | null,
  maintenant: Date = new Date(),
): boolean {
  if (!dateRefus) return true;
  const refus = new Date(dateRefus);
  if (Number.isNaN(refus.getTime())) return true;
  const ecartJours = (maintenant.getTime() - refus.getTime()) / 86_400_000;
  return ecartJours >= DELAI_REFUS_JOURS;
}
