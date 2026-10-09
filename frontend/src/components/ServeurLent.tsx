import { useEffect, useState } from "react";
import { t } from "../i18n";
import { useConnexion } from "../lib/connexion";

/** Bandeau d'état du réseau : « hors-ligne » (plus de connexion) ou « le serveur
 * se réveille » (requête > 3 s : serveur gratuit en veille qui redémarre). */
export function ServeurLent() {
  const [n, setN] = useState(0);
  const horsLigne = useConnexion() === "hors-ligne";
  useEffect(() => {
    const onLent = (e: Event) => setN((v) => Math.max(0, v + ((e as CustomEvent<number>).detail ?? 0)));
    window.addEventListener("serveur-lent", onLent);
    return () => {
      window.removeEventListener("serveur-lent", onLent);
    };
  }, []);
  if (!horsLigne && n === 0) return null;
  return (
    <div role="status" className="bg-highlight-soft px-4 py-2 text-center text-xs text-ink">
      {horsLigne
        ? t("Tu es hors-ligne — les épreuves téléchargées restent lisibles.")
        : t("Le serveur se réveille… cela peut prendre jusqu'à une minute, merci de patienter.")}
    </div>
  );
}
