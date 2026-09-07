/**
 * Formate une date ISO en expression relative française courte
 * ("à l'instant", "il y a 5 min", "il y a 3 h", "il y a 2 j", "il y a 3 sem",
 * "il y a 2 mois", "il y a 1 an") — utilisé pour l'historique de consultation
 * (catalogue) plutôt qu'un simple "déjà consultée" qui ne renseignait
 * pas sur l'ancienneté.
 */
export function formatRelativeTime(isoDate: string): string {
  const then = new Date(isoDate);

  // Évite d'afficher une valeur incohérente si la date est invalide.
  if (Number.isNaN(then.getTime())) return "";

  const now = new Date();

  // Une date future est considérée comme "à l'instant".
  if (then > now) return "à l'instant";

  const diffSeconds = Math.floor(
    (now.getTime() - then.getTime()) / 1000,
  );

  if (diffSeconds < 60) return "à l'instant";

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `il y a ${diffMinutes} min`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `il y a ${diffHours} h`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `il y a ${diffDays} j`;

  const diffWeeks = Math.floor(diffDays / 7);
  if (diffDays < 30) return `il y a ${diffWeeks} sem`;

  // Calcul des mois calendaires plutôt qu'une approximation de 30 jours.
  let diffMonths =
    (now.getFullYear() - then.getFullYear()) * 12 +
    (now.getMonth() - then.getMonth());

  if (now.getDate() < then.getDate()) {
    diffMonths--;
  }

  if (diffMonths < 12) {
    return `il y a ${Math.max(1, diffMonths)} mois`;
  }

  // Calcul des années calendaires.
  let diffYears = now.getFullYear() - then.getFullYear();

  if (
    now.getMonth() < then.getMonth() ||
    (now.getMonth() === then.getMonth() &&
      now.getDate() < then.getDate())
  ) {
    diffYears--;
  }

  return `il y a ${Math.max(1, diffYears)} an${diffYears > 1 ? "s" : ""}`;
}