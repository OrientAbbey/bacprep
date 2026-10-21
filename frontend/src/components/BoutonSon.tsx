import { Volume2, VolumeX } from "lucide-react";
import { useState } from "react";
import { t } from "../i18n";
import { reglerSon, sonActif } from "../lib/son";

/** Interrupteur de l'alarme sonore (préférence mémorisée sur l'appareil : en classe, on peut la couper). */
export function BoutonSon() {
  const [actif, setActif] = useState(sonActif);
  const basculer = () => {
    reglerSon(!actif);
    setActif(!actif);
  };
  return (
    <button
      type="button"
      onClick={basculer}
      aria-pressed={actif}
      aria-label={actif ? t("Couper le son de l'alarme") : t("Activer le son de l'alarme")}
      title={actif ? t("Alarme sonore activée") : t("Alarme sonore coupée")}
      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-slate hover:text-ink"
    >
      {actif ? <Volume2 size={16} strokeWidth={1.75} aria-hidden="true" /> : <VolumeX size={16} strokeWidth={1.75} aria-hidden="true" />}
    </button>
  );
}
