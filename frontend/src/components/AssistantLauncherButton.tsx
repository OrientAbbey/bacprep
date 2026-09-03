import { MessageCircle } from "lucide-react";

export function AssistantLauncherButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Ouvrir l'assistant"
      style={{ position: "fixed", right: 20, bottom: 20, zIndex: 40 }}
      // bg-margin/text-margin-text : fixes dans les 2 thèmes par
      // conception (bouton toujours sombre). Répétés explicitement sur
      // :hover/:focus-visible/:active pour empêcher tout repaint
      // heuristique du navigateur de rendre le texte illisible au survol
      // (voir la règle color-scheme globale dans index.css).
      className="flex items-center gap-2 rounded-full bg-margin px-5 py-3 text-sm font-medium text-margin-text shadow-xl hover:bg-margin hover:text-margin-text focus-visible:bg-margin focus-visible:text-margin-text active:bg-margin active:text-margin-text dark:shadow-[0_0_0_5px_rgba(214,174,85,0.14)]"
    >
      <MessageCircle size={18} strokeWidth={1.75} aria-hidden="true" />
      Assistant
    </button>
  );
}
