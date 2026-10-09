import { useSyncExternalStore } from "react";

/** État du réseau vu par l'application, sans trafic supplémentaire : il suit les évènements
 * `online`/`offline` du navigateur et le résultat des vraies requêtes (le client API signale
 * chaque succès ou coupure via `signalerReseau`). Un seul ping, au retour de la connexion. */
export type EtatConnexion = "ok" | "hors-ligne";

let etat: EtatConnexion = typeof navigator !== "undefined" && !navigator.onLine ? "hors-ligne" : "ok";
const abonnes = new Set<() => void>();

export function signalerReseau(ok: boolean): void {
  // Hors-ligne déclaré par le navigateur : une réponse servie depuis le cache du service worker
  // (lecture hors-ligne) ne prouve PAS que le réseau marche ; seul l'évènement `online` le rétablit.
  if (ok && typeof navigator !== "undefined" && !navigator.onLine) return;
  const suivant: EtatConnexion = ok ? "ok" : "hors-ligne";
  if (suivant === etat) return;
  etat = suivant;
  abonnes.forEach((f) => f());
}

/** Erreur de `fetch` due au réseau lui-même (hors-ligne, DNS, serveur éteint) : un TypeError, sans réponse HTTP. */
export const estErreurReseau = (err: unknown): boolean => err instanceof TypeError;

if (typeof window !== "undefined") {
  window.addEventListener("offline", () => signalerReseau(false));
  // `online` ne prouve pas qu'Internet répond (simple lien réseau) : on le vérifie une fois.
  window.addEventListener("online", () => {
    fetch("/api/health/live", { cache: "no-store" })
      .then(() => signalerReseau(true))
      .catch(() => signalerReseau(false));
  });
}

/** État courant (lecture seule) : utile hors composant et pour les tests. */
export const etatConnexion = (): EtatConnexion => etat;

export function useConnexion(): EtatConnexion {
  return useSyncExternalStore(
    (cb) => {
      abonnes.add(cb);
      return () => abonnes.delete(cb);
    },
    () => etat
  );
}
