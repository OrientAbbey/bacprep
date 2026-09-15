import { Flag, Send, X } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import type { MotifSignalement } from "../api/types";
import { MOTIFS } from "../lib/motifs";
import { useModalFocus } from "../lib/useModalFocus";
import { useToast } from "./Toast";

/**
 * Modale de signalement d'un problème sur une épreuve (bouton drapeau du
 * lecteur). Un motif par signalement + message libre optionnel ; un même
 * motif déjà ouvert sur la même épreuve est refusé côté serveur (409).
 */
export function SignalementModal({
  epreuveId,
  onClose,
}: {
  epreuveId: string;
  onClose: () => void;
}) {
  const { showToast } = useToast();
  const [motif, setMotif] = useState<MotifSignalement | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  // Focus initial dans la modale, piège Tab, fermeture sur Échap et
  // restauration du focus à l'élément déclencheur à la fermeture.
  const dialogRef = useModalFocus<HTMLDivElement>({ open: true, onClose });

  async function send() {
    if (!motif) return;
    setSending(true);
    try {
      await api.post(`/api/epreuves/${epreuveId}/signalements`, { motif, message: message.trim() });
      showToast("Signalement envoyé — merci, l'équipe va vérifier le contenu.", "success");
      onClose();
    } catch (err: unknown) {
      const detail = (err as { detail?: unknown }).detail;
      showToast(
        typeof detail === "string"
          ? detail
          : "Le signalement n'a pas pu être envoyé — réessaie.",
        "error"
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Signaler un problème"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-lg border border-ink-soft/15 bg-paper-raised shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-soft/15 px-4 py-3">
          <p className="font-serif-brand text-lg">Signaler un problème</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="relative p-1 text-ink-soft hover:text-ink after:absolute after:-inset-[9px] after:rounded-full after:content-['']"
          >
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <p className="font-mono-tag text-[10px] text-ink-soft">Quel est le problème ?</p>
          <div role="radiogroup" aria-label="Motif du signalement" className="space-y-1.5">
            {MOTIFS.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setMotif(m.value)}
                aria-pressed={motif === m.value}
                className={`flex min-h-[40px] w-full items-center gap-2 rounded-lg border px-3 text-left text-sm transition-colors ${
                  motif === m.value
                    ? "border-highlight bg-highlight-soft/40"
                    : "border-ink-soft/15 hover:border-highlight/50"
                }`}
              >
                <Flag
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  className={motif === m.value ? "text-highlight" : "text-slate"}
                />
                {m.label}
              </button>
            ))}
          </div>

          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            placeholder="Détails (optionnel) — question concernée, ce qui cloche…"
            className="w-full rounded-md border border-ink-soft/25 bg-paper p-3 text-sm"
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-ink-soft/15 p-3">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] rounded-full border border-ink-soft/25 px-4 text-sm text-ink-soft"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={send}
            disabled={!motif || sending}
            className="flex min-h-[44px] items-center gap-2 rounded-full bg-ink px-5 text-sm font-medium text-paper disabled:opacity-50"
          >
            <Send size={15} strokeWidth={1.75} aria-hidden="true" />
            Envoyer
          </button>
        </div>
      </div>
    </div>
  );
}
