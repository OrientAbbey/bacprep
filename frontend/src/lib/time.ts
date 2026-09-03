/**
 * Formate une date ISO en expression relative française courte
 * ("à l'instant", "il y a 5 min", "il y a 3 h", "il y a 2 j", "il y a 3 sem",
 * puis une date absolue courte au-delà d'un mois) — utilisé pour
 * l'historique de consultation (catalogue) plutôt qu'un simple "déjà
 * consultée" qui ne renseignait pas sur l'ancienneté.
 */
export function formatRelativeTime(isoDate: string): string {
  const then = new Date(isoDate).getTime();
  const now = Date.now();
  const diffSeconds = Math.max(0, Math.floor((now - then) / 1000));

  if (diffSeconds < 30) return "à l'instant";
  if (diffSeconds < 60) return `il y a ${diffSeconds} s`;

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `il y a ${diffMinutes} min`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `il y a ${diffHours} h`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `il y a ${diffDays} j`;

  const diffWeeks = Math.floor(diffDays / 7);
  if (diffDays < 30) return `il y a ${diffWeeks} sem`;

  const diffMonths = Math.floor(diffDays / 30);
  if (diffDays < 365) return `il y a ${diffMonths} mois`;

  const diffYears = Math.floor(diffDays / 365);
  return `il y a ${diffYears} an${diffYears > 1 ? "s" : ""}`;
}
