import { useState } from "react";
import { t } from "../i18n";

const TAILLES = [0.9, 1, 1.15, 1.3];
const CLE = "bacprep-taille-texte";

/** Taille du texte du lecteur (mémorisée sur l'appareil). `zoom` est appliqué
 * au conteneur du contenu par l'appelant. */
export function useTailleTexte(): [number, (delta: -1 | 1) => void] {
  const [i, setI] = useState(() => {
    try {
      const v = Number(localStorage.getItem(CLE));
      return v >= 0 && v < TAILLES.length && localStorage.getItem(CLE) !== null ? v : 1;
    } catch {
      return 1;
    }
  });
  const changer = (delta: -1 | 1) => {
    const n = Math.min(TAILLES.length - 1, Math.max(0, i + delta));
    setI(n);
    try {
      localStorage.setItem(CLE, String(n));
    } catch {
      /* stockage indisponible : réglage non mémorisé */
    }
  };
  return [TAILLES[i], changer];
}

export function TailleTexte({ taille, onChange }: { taille: number; onChange: (d: -1 | 1) => void }) {
  return (
    <div role="group" aria-label={t("Taille du texte")} className="flex items-center rounded-full border border-ink-soft/20 text-sm">
      <button type="button" onClick={() => onChange(-1)} disabled={taille <= TAILLES[0]} aria-label={t("Réduire le texte")} className="min-h-[44px] min-w-[44px] disabled:opacity-40">
        A−
      </button>
      <button type="button" onClick={() => onChange(1)} disabled={taille >= TAILLES[TAILLES.length - 1]} aria-label={t("Agrandir le texte")} className="min-h-[44px] min-w-[44px] text-base disabled:opacity-40">
        A+
      </button>
    </div>
  );
}
