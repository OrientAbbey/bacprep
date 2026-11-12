import { BookOpen } from "lucide-react";
import { t } from "../i18n";

/** Bouton « Lecture paginée » : bascule entre le texte continu et la lecture page par page sur feuille A4. */
export function BasculePages({ pagine, onChange }: { pagine: boolean; onChange: (pagine: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={pagine}
      aria-label={t("Lecture paginée")}
      onClick={() => onChange(!pagine)}
      title={pagine ? t("Afficher le texte en continu") : t("Lire page par page")}
      className={`flex min-h-[44px] items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold sm:px-3 ${
        pagine ? "bg-ink text-paper" : "text-ink-soft hover:bg-highlight-soft"
      }`}
    >
      <BookOpen size={15} strokeWidth={1.75} aria-hidden="true" />
      <span className="hidden sm:inline">{t("Lecture paginée")}</span>
    </button>
  );
}
