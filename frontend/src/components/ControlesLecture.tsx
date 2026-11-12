import { t } from "../i18n";
import { ZOOM_MAX, ZOOM_MIN } from "../lib/zoomLecteur";
import { BasculePages } from "./BasculePages";

/** Contrôles flottants du lecteur, réunis dans une seule pastille : lecture paginée, A−, pourcentage
 *  (cliquer = revenir à 100 %) et A+. Placés hors de la feuille, ils ne recouvrent jamais le texte. */
export function ControlesLecture({
  taille,
  pagine,
  onPagine,
  onZoom,
  onReset,
}: {
  taille: number;
  pagine: boolean;
  onPagine: (pagine: boolean) => void;
  onZoom: (delta: -1 | 1) => void;
  onReset: () => void;
}) {
  const pct = Math.round(taille * 100);
  const bouton =
    "flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full px-1 text-sm font-semibold text-ink hover:bg-highlight-soft disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div className="flex items-center gap-0.5 rounded-full border border-ink-soft/20 bg-paper-raised/95 p-0.5 shadow-lg backdrop-blur">
      <BasculePages pagine={pagine} onChange={onPagine} />
      <span aria-hidden="true" className="mx-0.5 h-6 w-px bg-ink-soft/20" />
      <button
        type="button"
        onClick={() => onZoom(-1)}
        disabled={taille <= ZOOM_MIN + 0.001}
        aria-label={t("Réduire le texte")}
        title={t("Réduire le texte")}
        className={bouton}
      >
        A−
      </button>
      <button
        type="button"
        onClick={onReset}
        aria-label={t("Taille du texte : {pct} % — cliquer pour revenir à 100 %", { pct })}
        title={t("Taille du texte : {pct} % — cliquer pour revenir à 100 %", { pct })}
        className="min-h-[44px] min-w-[3.25rem] rounded-full px-1 font-mono-tag text-[11px] text-ink-soft hover:bg-highlight-soft"
      >
        {pct} %
      </button>
      <button
        type="button"
        onClick={() => onZoom(1)}
        disabled={taille >= ZOOM_MAX - 0.001}
        aria-label={t("Agrandir le texte")}
        title={t("Agrandir le texte")}
        className={`${bouton} text-base`}
      >
        A+
      </button>
    </div>
  );
}
