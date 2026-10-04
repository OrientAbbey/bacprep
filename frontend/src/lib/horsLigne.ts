/** Lecture hors-ligne : copie locale d'une épreuve (JSON + images) dans le Cache
 * Storage, aux mêmes noms que le service worker (voir vite.config.ts), qui la
 * sert quand le réseau est absent. La liste des épreuves téléchargées (pour
 * l'écran d'accueil) est dans localStorage ; tout est purgé à la déconnexion
 * et après 30 jours. */
const CLE = "bacprep-hors-ligne";
const TTL_MS = 30 * 24 * 3600 * 1000;
const CACHES = ["epreuves", "epreuves-images", "session"];

export interface Telechargee {
  id: string;
  matiere: string;
  annee: string;
  evaluation: string;
  ajoute: number;
}

function lire(): Telechargee[] {
  try {
    const l: Telechargee[] = JSON.parse(localStorage.getItem(CLE) ?? "[]");
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}
const ecrire = (l: Telechargee[]) => {
  try {
    localStorage.setItem(CLE, JSON.stringify(l));
  } catch {
    /* stockage plein ou indisponible : la copie reste utilisable, seule la liste manque */
  }
};

/** Épreuves téléchargées et encore valides (les plus récentes d'abord). */
export function listeHorsLigne(): Telechargee[] {
  return lire().filter((e) => Date.now() - e.ajoute < TTL_MS).sort((a, b) => b.ajoute - a.ajoute);
}
export const estTelechargee = (id: string) => listeHorsLigne().some((e) => e.id === id);
export const horsLigneDisponible = () => typeof caches !== "undefined" && "serviceWorker" in navigator;

/** Images d'épreuve référencées dans le contenu (`/api/files/…`, jeton éventuel compris). */
export function imagesDe(texte: string): string[] {
  return [...new Set(texte.match(/\/api\/files\/[A-Za-z0-9_-]+(?:\?token=[^\s)"'\\#]+)?/g) ?? [])];
}

/** Télécharge l'épreuve et ses images ; renvoie le nombre d'images mises de côté. */
export async function telecharger(meta: Omit<Telechargee, "ajoute">): Promise<number> {
  const url = `/api/epreuves/${meta.id}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const corps = await res.clone().text();
  await (await caches.open("epreuves")).put(url, res);
  const images = await caches.open("epreuves-images");
  let n = 0;
  for (const src of imagesDe(corps)) {
    try {
      const r = await fetch(src, { credentials: "include" });
      if (r.ok) {
        await images.put(src, r);
        n += 1;
      }
    } catch {
      /* une image manquante ne bloque pas le téléchargement du texte */
    }
  }
  ecrire([...lire().filter((e) => e.id !== meta.id), { ...meta, ajoute: Date.now() }]);
  return n;
}

export async function retirer(id: string): Promise<void> {
  ecrire(lire().filter((e) => e.id !== id));
  try {
    await (await caches.open("epreuves")).delete(`/api/epreuves/${id}`);
  } catch {
    /* cache indisponible */
  }
}

/** Efface toute copie locale (déconnexion : un autre élève peut utiliser l'appareil). */
export async function viderHorsLigne(): Promise<void> {
  try {
    localStorage.removeItem(CLE);
    if (typeof caches !== "undefined") await Promise.all(CACHES.map((c) => caches.delete(c)));
  } catch {
    /* rien à purger */
  }
}
