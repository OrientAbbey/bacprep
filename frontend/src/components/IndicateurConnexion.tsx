import { Cloud, CloudOff } from "lucide-react";
import { t } from "../i18n";
import { useConnexion } from "../lib/connexion";

/** Nuage de l'en-tête : vert = en ligne, rouge = hors connexion (réseau coupé ou serveur injoignable). */
export function IndicateurConnexion() {
  const etat = useConnexion();
  const ok = etat === "ok";
  const libelle = ok ? t("Connecté à Internet") : t("Hors connexion");
  return (
    <span
      role="status"
      aria-label={libelle}
      title={libelle}
      data-connexion={etat}
      className={`flex h-9 w-9 items-center justify-center ${ok ? "text-valide" : "text-correction"}`}
    >
      {ok ? <Cloud size={20} strokeWidth={1.75} aria-hidden="true" /> : <CloudOff size={20} strokeWidth={1.75} aria-hidden="true" />}
    </span>
  );
}
