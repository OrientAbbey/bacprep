import { MessageCircle, StickyNote } from "lucide-react";
import { t } from "../i18n";

/** Barre flottante à deux actions qui apparaît sur une sélection de texte
 * du lecteur : « Demander » (ouvre Tuteur IA Prep sur ce passage) et
 * « Prendre une note » (ouvre l'éditeur de note prérempli). Même
 * positionnement viewport-pur que l'ancien bouton unique. Couleurs
 * distinctes par action : encre (assistant), vert (note) — le doré restant
 * réservé au surlignage de la sélection elle-même.
 *
 * Découvrabilité : pour un visiteur (ou notes refusées), les actions
 * concernées restent AFFICHÉES mais désactivées avec le motif du verrou en
 * info-bulle — on voit ce qui existe, on comprend ce qui le verrouille ;
 * seul le lanceur flottant de l'assistant disparaît entièrement. */
export function SelectionBar({
  x,
  y,
  onAsk,
  onNote,
  peutDemander = true,
  peutNoter = true,
  motifVerrou = t("Connecte-toi pour utiliser cette fonctionnalité"),
}: {
  x: number;
  y: number;
  /** Panneau fermé → nouvelle discussion avec ce contexte ; ouvert →
   * collage dans le chat courant (comportement géré par le parent). */
  onAsk: () => void;
  /** Ouvre l'éditeur de note avec ce passage en contexte. */
  onNote: () => void;
  /** Faux en visiteur : bouton affiché mais désactivé. */
  peutDemander?: boolean;
  /** Faux en visiteur OU si les notes sont refusées (consentement). */
  peutNoter?: boolean;
  /** Motif affiché en info-bulle sur les boutons désactivés. */
  motifVerrou?: string;
}) {
  // Coordonnées VIEWPORT-RELATIVES PURES (position: fixed) — ne jamais
  // ajouter window.scrollY/scrollX (bouton qui dérivait au défilement).
  const clampedX = Math.min(Math.max(x, 16), window.innerWidth - 260);
  const clampedY = Math.min(Math.max(y, 16), window.innerHeight - 56);

  return (
    <div
      role="toolbar"
      aria-label={t("Actions sur la sélection")}
      style={{ position: "fixed", left: clampedX, top: clampedY, zIndex: 50 }}
      className="flex items-center gap-1 rounded-full border border-ink-soft/20 bg-paper-raised p-1 shadow-lg"
    >
      <button
        type="button"
        onClick={onAsk}
        disabled={!peutDemander}
        aria-label={t("Demander à Tuteur IA Prep sur ce passage")}
        title={peutDemander ? t("Demander à Tuteur IA Prep sur ce passage") : motifVerrou}
        className={`flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${
          peutDemander ? "verrou-ink" : "verrou-ink cursor-not-allowed opacity-50"
        }`}
      >
        <MessageCircle size={14} strokeWidth={1.75} aria-hidden="true" />
        {t("Demander")}
      </button>
      <button
        type="button"
        onClick={onNote}
        disabled={!peutNoter}
        aria-label={t("Prendre une note sur ce passage")}
        title={peutNoter ? "Prendre une note sur ce passage" : motifVerrou}
        className={`flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${
          peutNoter ? "verrou-valide" : "verrou-valide cursor-not-allowed opacity-50"
        }`}
      >
        <StickyNote size={14} strokeWidth={1.75} aria-hidden="true" />
        {t("Prendre une note")}
      </button>
    </div>
  );
}
