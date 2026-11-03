/** Alarme sonore de fin de chronomètre : bips générés par WebAudio (aucun fichier audio), répétés en continu
 * jusqu'à l'arrêt manuel ou, au plus tard, une minute après le début. Les navigateurs n'autorisent le son
 * qu'après un geste de l'utilisateur : `preparerSon()` est donc appelé au clic « Démarrer » (le contexte audio
 * reste ensuite utilisable quand le minuteur sonne). */
const CLE = "bacprep-son";

export function sonActif(): boolean {
  try {
    return localStorage.getItem(CLE) !== "off";
  } catch {
    return true;
  }
}

export function reglerSon(actif: boolean): void {
  try {
    localStorage.setItem(CLE, actif ? "on" : "off");
  } catch {
    /* préférence non mémorisée */
  }
}

let contexte: AudioContext | null = null;

type FabriqueAudio = typeof AudioContext;
const fabrique = (): FabriqueAudio | undefined =>
  typeof window === "undefined" ? undefined : window.AudioContext ?? (window as unknown as { webkitAudioContext?: FabriqueAudio }).webkitAudioContext;

/** À appeler DANS un geste utilisateur (clic) : crée/réveille le contexte audio. */
export function preparerSon(): void {
  const AC = fabrique();
  if (!AC) return;
  try {
    contexte ??= new AC();
    if (contexte.state === "suspended") void contexte.resume();
  } catch {
    contexte = null;
  }
}

export const DUREE_ALARME_MS = 60_000;
const PERIODE_BIP_MS = 800;

let cadence: ReturnType<typeof setInterval> | null = null;
let arretAuto: ReturnType<typeof setTimeout> | null = null;
let sonne = false;
const ecouteurs = new Set<() => void>();

/** État de l'alarme observable par l'interface (`useSyncExternalStore`). */
export const alarmeEnCours = (): boolean => sonne;
export function surAlarme(rappel: () => void): () => void {
  ecouteurs.add(rappel);
  return () => void ecouteurs.delete(rappel);
}

/** Un bip de 0,25 s (880 Hz). */
function bip(): void {
  if (!contexte) return;
  try {
    const debut = contexte.currentTime;
    const osc = contexte.createOscillator();
    const gain = contexte.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, debut);
    gain.gain.exponentialRampToValueAtTime(0.3, debut + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, debut + 0.25);
    osc.connect(gain).connect(contexte.destination);
    osc.start(debut);
    osc.stop(debut + 0.27);
  } catch {
    /* l'alarme sonore est un confort : le décompte visuel reste la référence */
  }
}

/** Arrête l'alarme (sans effet si elle ne sonne pas). */
export function arreterAlarme(): void {
  if (cadence !== null) clearInterval(cadence);
  if (arretAuto !== null) clearTimeout(arretAuto);
  cadence = arretAuto = null;
  if (sonne) {
    sonne = false;
    ecouteurs.forEach((rappel) => rappel());
  }
}

/** Lance l'alarme : un bip toutes les 0,8 s jusqu'à `arreterAlarme()` ou `DUREE_ALARME_MS`. Silencieuse si le son
 * est coupé ou si l'audio est indisponible (rien à arrêter : `alarmeEnCours()` reste faux). */
export function demarrerAlarme(): void {
  arreterAlarme();
  if (!sonActif() || !contexte) return;
  sonne = true;
  bip();
  cadence = setInterval(bip, PERIODE_BIP_MS);
  arretAuto = setTimeout(arreterAlarme, DUREE_ALARME_MS);
  ecouteurs.forEach((rappel) => rappel());
}
