/** Heure courte HH:MM (locale fr) d'un horodatage ISO, ou null si la
 * valeur est absente/invalide (messages anciens sans `ts`). */
export function heureCourte(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(d);
}

/** Date complète + heure pour l'attribut `title` (survol) d'un message,
 * ou null si la valeur est absente/invalide. */
export function dateLongue(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeStyle: "short" }).format(d);
}