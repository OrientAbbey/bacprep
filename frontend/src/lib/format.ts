import { locale } from "../i18n";
/** Utilitaires de formatage de valeurs numériques (poids fichiers, etc.). */

/** Formate un nombre d'octets en unité lisible : 1536 → « 1,5 Ko »,
 * 2_400_000 → « 2,3 Mo ». Retourne "—" si la valeur est absente. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} o`;
  const ko = bytes / 1024;
  if (ko < 1024) return `${ko.toLocaleString(locale(), { maximumFractionDigits: 1 })} Ko`;
  const mo = ko / 1024;
  if (mo < 1024) return `${mo.toLocaleString(locale(), { maximumFractionDigits: 1 })} Mo`;
  return `${(mo / 1024).toLocaleString(locale(), { maximumFractionDigits: 1 })} Go`;
}
