/** Zoom de la feuille du lecteur : boutons A−/A+ par paliers, ou pincement à deux doigts (continu). */
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 2;
export const PALIERS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];

const CLE = "bacprep-zoom-lecteur";
const EPSILON = 0.001;

export const borner = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/** Palier suivant (+1) ou précédent (−1) : la valeur courante peut venir d'un pincement, donc être entre deux paliers. */
export function palierVoisin(zoom: number, delta: -1 | 1): number {
  if (delta === 1) return PALIERS.find((p) => p > zoom + EPSILON) ?? ZOOM_MAX;
  return [...PALIERS].reverse().find((p) => p < zoom - EPSILON) ?? ZOOM_MIN;
}

/** Zoom après un pincement : zoom de départ × rapport des écartements des deux doigts, borné. */
export function zoomPince(depart: number, ecartDepart: number, ecart: number): number {
  return ecartDepart > 0 ? borner((depart * ecart) / ecartDepart) : depart;
}

export function zoomInitial(): number {
  try {
    const v = Number(localStorage.getItem(CLE));
    return localStorage.getItem(CLE) !== null && Number.isFinite(v) && v > 0 ? borner(v) : 1;
  } catch {
    return 1;
  }
}

export function memoriserZoom(zoom: number): void {
  try {
    localStorage.setItem(CLE, String(zoom));
  } catch {
    /* stockage indisponible : réglage non mémorisé */
  }
}
