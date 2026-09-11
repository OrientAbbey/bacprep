import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { useModalFocus } from "../lib/useModalFocus";

/**
 * Dialogue de confirmation réutilisable (remplace les `confirm()` natifs,
 * inaccessibles et hors design system). L'action de confirmation est
 * attendue async : le bouton affiche un état « En cours… » et la modale se
 * ferme une fois l'action terminée.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirmer",
  cancelLabel = "Annuler",
  tone = "default",
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const dialogRef = useModalFocus<HTMLDivElement>({ open: true, onClose });

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-titre"
      aria-describedby="confirm-message"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-sm rounded-lg border border-ink-soft/15 bg-paper-raised p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          <AlertTriangle
            size={18}
            strokeWidth={1.75}
            aria-hidden="true"
            className={`mt-0.5 shrink-0 ${tone === "danger" ? "text-correction" : "text-highlight"}`}
          />
          <h2 id="confirm-titre" className="font-serif-brand text-lg">
            {title}
          </h2>
        </div>
        <p id="confirm-message" className="mt-2 text-sm text-ink-soft">
          {message}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-[44px] rounded-full border border-ink-soft/25 px-4 text-sm text-ink-soft disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className={`min-h-[44px] rounded-full px-5 text-sm font-medium text-paper disabled:opacity-50 ${
              tone === "danger" ? "bg-correction" : "bg-ink"
            }`}
          >
            {busy ? "En cours…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}