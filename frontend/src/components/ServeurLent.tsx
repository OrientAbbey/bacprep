import { useEffect, useState } from "react";

/** Bandeau affiché quand une requête met plus de 3 s (serveur gratuit en
 * veille qui redémarre) : l'élève sait qu'il faut patienter. */
export function ServeurLent() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const onLent = (e: Event) => setN((v) => Math.max(0, v + ((e as CustomEvent<number>).detail ?? 0)));
    window.addEventListener("serveur-lent", onLent);
    return () => window.removeEventListener("serveur-lent", onLent);
  }, []);
  if (n === 0) return null;
  return (
    <div role="status" className="bg-highlight-soft px-4 py-2 text-center text-xs text-ink">
      Le serveur se réveille… cela peut prendre jusqu'à une minute, merci de patienter.
    </div>
  );
}
