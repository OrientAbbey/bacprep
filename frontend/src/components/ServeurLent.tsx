import { useEffect, useState } from "react";
import { t } from "../i18n";

/** Bandeau d'état du réseau : « hors-ligne » (plus de connexion) ou « le serveur
 * se réveille » (requête > 3 s : serveur gratuit en veille qui redémarre). */
export function ServeurLent() {
  const [n, setN] = useState(0);
  const [horsLigne, setHorsLigne] = useState(typeof navigator !== "undefined" && !navigator.onLine);
  useEffect(() => {
    const onLent = (e: Event) => setN((v) => Math.max(0, v + ((e as CustomEvent<number>).detail ?? 0)));
    const maj = () => setHorsLigne(!navigator.onLine);
    window.addEventListener("serveur-lent", onLent);
    window.addEventListener("online", maj);
    window.addEventListener("offline", maj);
    return () => {
      window.removeEventListener("serveur-lent", onLent);
      window.removeEventListener("online", maj);
      window.removeEventListener("offline", maj);
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
