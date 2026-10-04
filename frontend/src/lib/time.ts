import { getLang } from "../i18n";

const rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];

/**
 * Formate une date ISO en expression relative française courte
 * ("à l'instant", "il y a 5 minutes", "il y a 2 jours"…)
 * via `Intl.RelativeTimeFormat` (stdlib, ~15 lignes au lieu de 60).
 */
export function formatRelativeTime(isoDate: string): string {
  const then = new Date(isoDate);
  if (Number.isNaN(then.getTime())) return "";

  const diffSec = Math.floor((then.getTime() - Date.now()) / 1000);

  for (const [unit, secs] of UNITS) {
    const value = Math.round(diffSec / secs);
    if (Math.abs(value) >= 1 || unit === "second") {
      return rtf.format(value, unit);
    }
  }
  return "";
}