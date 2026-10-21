import { Layers, Rows3 } from "lucide-react";
import { t } from "../i18n";
import { memoriserAffichage, type AffichageSujets } from "../lib/sujets";

/** « Page par page » / « Toutes les pages » : visible seulement quand l'épreuve a plusieurs sujets. */
export function BasculeAffichage({ valeur, onChange }: { valeur: AffichageSujets; onChange: (a: AffichageSujets) => void }) {
  const options: [AffichageSujets, string, typeof Layers][] = [
    ["page", t("Page par page"), Rows3],
    ["tout", t("Toutes les pages"), Layers],
  ];
  return (
    <div role="group" aria-label={t("Affichage des sujets")} className="flex overflow-hidden rounded-full border border-ink-soft/20 text-xs">
      {options.map(([v, libelle, Icone]) => (
        <button
          key={v}
          type="button"
          aria-pressed={valeur === v}
          onClick={() => {
            memoriserAffichage(v);
            onChange(v);
          }}
          className={`flex min-h-[44px] items-center gap-1.5 px-3 ${valeur === v ? "bg-ink text-paper" : "text-ink-soft hover:bg-highlight-soft/50"}`}
        >
          <Icone size={14} strokeWidth={1.75} aria-hidden="true" />
          {libelle}
        </button>
      ))}
    </div>
  );
}
