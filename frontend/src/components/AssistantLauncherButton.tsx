import { MessageCircle } from "lucide-react";
import { t } from "../i18n";

export function AssistantLauncherButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("Ouvrir Tuteur IA Prep")}
      style={{ position: "fixed", right: 20, bottom: 20, zIndex: 40 }}
      // Couple margin/margin-text : fixes dans les 2 thèmes par conception
      // (bouton toujours sombre). La classe verrou-margin maintient
      // EXPLICITEMENT ces couleurs sur :hover/:focus-visible/:active contre
      // les repaints heuristiques des moteurs de rendu (voir index.css).
      className="verrou-margin halo-highlight flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium shadow-xl"
    >
      <MessageCircle size={18} strokeWidth={1.75} aria-hidden="true" />
      {t("Tuteur IA Prep")}
    </button>
  );
}
