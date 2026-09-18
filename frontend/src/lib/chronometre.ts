/** Utilitaires du chronomètre de traitement d'épreuve. */

/** Parse une durée d'épreuve libre (ex. « 4h », « 1h30 », « 45 min »)
 * en minutes — best-effort, null si ininterprétable, absente ou hors
 * bornes raisonnables (0 < minutes <= 24h). */
export function dureeEnMinutes(duree?: string | null): number | null {
  if (!duree) return null;
  const norm = duree.trim().toLowerCase().replace(/\s+/g, "");
  const h = norm.match(/(\d+)h/);
  // Portion restante après le « h » (s'il y en a un) : les minutes qui
  // suivent l'heure comptent ici, sans jamais recapturer le chiffre des
  // heures (taper sa propre durée « 1h30 » : 60 + 30, pas 1 + 30).
  const reste = h ? norm.slice(norm.indexOf("h") + 1) : norm;
  const m = reste.match(/(\d+)m(?:in)?/);
  const minutesSeules = /^\d+$/.test(reste) ? Number(reste) : 0;
  const total = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0) + minutesSeules;
  if (total <= 0 || total > 24 * 60) return null;
  return total;
}

/** Formate une durée en secondes pour l'affichage — HH:MM:SS dès qu'une
 * heure est atteinte, sinon MM:SS. Les valeurs négatives sont bornées à 0. */
export function formaterDurée(secondes: number): string {
  const s = Math.max(0, secondes);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}