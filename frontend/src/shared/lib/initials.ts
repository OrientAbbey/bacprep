/**
 * Dérive des initiales (2 lettres) à partir d'un nom complet, pour
 * l'avatar du profil — ex. "Franck Albert" -> "FA". Retombe sur les 2
 * premières lettres du seul mot disponible s'il n'y a qu'un prénom, ou
 * "?" si le nom est vide.
 */
export function getInitials(nom: string): string {
  const parts = nom.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
