import { MessageCircle } from "lucide-react";

export function FloatingAskButton({
  x,
  y,
  onClick,
  label,
}: {
  x: number;
  y: number;
  onClick: () => void;
  /** "Demander à l'assistant" (panneau fermé, ouvre une nouvelle
   * discussion) ou "Copier dans le chat" (panneau déjà ouvert, colle le
   * texte dans la discussion en cours sans toucher à son contexte). */
  label: string;
}) {
  // Coordonnées VIEWPORT-RELATIVES PURES (l'élément est position: fixed).
  // Ne jamais ajouter window.scrollY/scrollX ici : bug déjà rencontré où le
  // bouton dérivait hors écran au défilement (voir CAHIER_DES_CHARGES 12.5).
  const clampedX = Math.min(Math.max(x, 16), window.innerWidth - 220);
  const clampedY = Math.min(Math.max(y, 16), window.innerHeight - 56);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{ position: "fixed", left: clampedX, top: clampedY, zIndex: 50 }}
      // bg-ink/text-paper s'adaptent ensemble au thème (toujours un couple
      // contrasté). Répétés sur :hover/:focus-visible pour empêcher tout
      // repaint heuristique du navigateur de casser ce contraste.
      className="flex items-center gap-2 whitespace-nowrap rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper shadow-lg hover:bg-ink hover:text-paper focus-visible:bg-ink focus-visible:text-paper active:bg-ink active:text-paper"
    >
      <MessageCircle size={18} strokeWidth={1.75} aria-hidden="true" />
      {label}
    </button>
  );
}
