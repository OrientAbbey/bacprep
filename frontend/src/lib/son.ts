/** Alarme sonore de fin de chronomètre : trois bips générés par WebAudio (aucun fichier audio).
 * Les navigateurs n'autorisent le son qu'après un geste de l'utilisateur : `preparerSon()` est donc
 * appelé au clic « Démarrer » (le contexte audio reste ensuite utilisable quand le minuteur sonne). */
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

/** Trois bips de 0,25 s (880 Hz). Silencieux si le son est coupé ou si l'audio est indisponible. */
export function jouerAlarme(): void {
  if (!sonActif() || !contexte) return;
  try {
    const t0 = contexte.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = contexte.createOscillator();
      const gain = contexte.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      const debut = t0 + i * 0.4;
      gain.gain.setValueAtTime(0.0001, debut);
      gain.gain.exponentialRampToValueAtTime(0.3, debut + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, debut + 0.25);
      osc.connect(gain).connect(contexte.destination);
      osc.start(debut);
      osc.stop(debut + 0.27);
    }
  } catch {
    /* l'alarme sonore est un confort : le décompte visuel reste la référence */
  }
}
