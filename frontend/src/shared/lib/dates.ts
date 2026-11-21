import { locale } from "../../i18n";

/** Horodatage court d'un message : DATE + heure, dans la langue choisie
 * ("15/09/2026 14:05"). L'heure seule ne suffit pas — une discussion reprise
 * le lendemain affichait « 20:53 » sans qu'on sache de quel jour il s'agit,
 * et deux questions identiques posées à des dates différentes devenaient
 * indiscernables. Renvoie null si la valeur est absente/invalide (messages
 * anciens sans `ts`). */
export function horodatageCourt(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(locale(), { dateStyle: "short", timeStyle: "short" }).format(d);
}

/** Date complète + heure pour l'attribut `title` (survol) d'un message,
 * ou null si la valeur est absente/invalide. */
export function dateLongue(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(locale(), { dateStyle: "full", timeStyle: "short" }).format(d);
}
