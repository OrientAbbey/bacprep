import { BellOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { t } from "../i18n";
import { alarmeEnCours, arreterAlarme, surAlarme } from "../lib/son";

/** Bandeau global tant que l'alarme sonne : arrêt manuel en un clic, où que soit l'élève (outils repliés en
 * immersion, autre page…). Sans arrêt, l'alarme s'éteint seule au bout d'une minute. */
export function BandeauAlarme() {
  const sonne = useSyncExternalStore(surAlarme, alarmeEnCours);
  if (!sonne) return null;
  return (
    <div role="alert" className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-3">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-ink px-4 py-2 text-sm text-paper shadow-lg">
        <span className="font-medium">{t("Temps écoulé — l'alarme sonne")}</span>
        <button type="button" onClick={arreterAlarme} className="flex min-h-[44px] items-center gap-1.5 rounded-full bg-paper px-4 font-medium text-ink">
          <BellOff size={16} strokeWidth={1.75} aria-hidden="true" />
          {t("Arrêter l'alarme")}
        </button>
      </div>
    </div>
  );
}
