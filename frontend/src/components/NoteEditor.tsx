import { Eye, Pencil, Save, X } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import type { Note } from "../api/types";
import { useEscapeKey } from "../lib/useEscapeKey";
import { MarkdownContent } from "./MarkdownContent";
import { useToast } from "./Toast";

/**
 * Éditeur de note personnelle, en modale. Deux usages :
 * - création (l'élève a sélectionné un passage et cliqué « Prendre une note ») :
 *   `epreuveId`, `cible` et `contexteExtrait` sont fournis, `note` est null ;
 * - édition depuis le profil : `note` est fourni (prérempli, modifiable).
 * Le contenu est du Markdown, avec aperçu rendu (formules LaTeX comprises).
 */
export function NoteEditor({
  epreuveId,
  cible = "sujet",
  note = null,
  contexteExtraitInitial = "",
  contenuInitial = "",
  onClose,
  onSaved,
}: {
  epreuveId: string;
  cible?: "sujet" | "corrige";
  note?: Note | null;
  /** Passage sélectionné (Markdown brut) ou réponse de l'assistant préremplie. */
  contexteExtraitInitial?: string;
  /** Contenu initial (ex. réponse de l'assistant « Sauvegarder en note »). */
  contenuInitial?: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { showToast } = useToast();
  const [contexte, setContexte] = useState(note?.contexte_extrait ?? contexteExtraitInitial);
  const [contenu, setContenu] = useState(note?.contenu ?? contenuInitial);
  const [apercu, setApercu] = useState(false);
  const [saving, setSaving] = useState(false);
  const edition = Boolean(note);

  useEscapeKey(onClose);

  async function save() {
    if (!contenu.trim()) return;
    setSaving(true);
    try {
      if (edition) {
        await api.put(`/api/me/notes/${note!.id}`, {
          contexte_extrait: contexte,
          contenu,
        });
      } else {
        await api.post(`/api/epreuves/${epreuveId}/notes`, {
          cible,
          contexte_extrait: contexte,
          contenu,
        });
      }
      showToast(edition ? "Note modifiée." : "Note enregistrée — retrouvable dans ton profil.", "success");
      onSaved?.();
      onClose();
    } catch {
      showToast("Échec de l'enregistrement de la note.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={edition ? "Modifier la note" : "Nouvelle note"}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-lg border border-ink-soft/15 bg-paper-raised shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-soft/15 px-4 py-3">
          <p className="font-serif-brand text-lg">{edition ? "Modifier la note" : "Prendre une note"}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer l'éditeur"
            className="p-1 text-ink-soft hover:text-ink"
          >
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {contexte.trim() && (
            <div className="rounded-lg border-l-4 border-highlight bg-highlight-soft/40 px-3 py-2">
              <p className="mb-1 font-mono-tag text-[10px] text-ink-soft">Passage associé</p>
              <p className="line-clamp-3 text-xs text-ink-soft">{contexte.replace(/\s+/g, " ")}</p>
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="font-mono-tag text-[10px] text-ink-soft">
              {apercu ? "Aperçu rendu" : "Contenu (Markdown, formules $...$ acceptées)"}
            </p>
            <button
              type="button"
              onClick={() => setApercu((a) => !a)}
              className="flex items-center gap-1.5 rounded-full border border-ink-soft/25 px-3 py-1 text-xs text-ink-soft hover:border-highlight/50"
            >
              {apercu ? <Pencil size={13} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={13} strokeWidth={1.75} aria-hidden="true" />}
              {apercu ? "Écrire" : "Aperçu"}
            </button>
          </div>

          {apercu ? (
            contenu.trim() ? (
              <div className="min-h-[160px] rounded-md border border-ink-soft/15 bg-paper p-3">
                <MarkdownContent content={contenu} variant="chat" />
              </div>
            ) : (
              <p className="min-h-[160px] rounded-md border border-ink-soft/15 bg-paper p-3 text-sm text-slate">
                Rien à prévisualiser pour l'instant — repasse en mode « Écrire ».
              </p>
            )
          ) : (
            <textarea
              value={contenu}
              onChange={(e) => setContenu(e.target.value)}
              rows={7}
              placeholder="Rédige ta note ici — définition, méthode, réponse de l'assistant…"
              className="w-full rounded-md border border-ink-soft/25 bg-paper p-3 font-mono text-sm"
            />
          )}
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
            onClick={save}
            disabled={saving || !contenu.trim()}
            className="flex min-h-[44px] items-center gap-2 rounded-full bg-ink px-5 text-sm font-medium text-paper disabled:opacity-50"
          >
            <Save size={15} strokeWidth={1.75} aria-hidden="true" />
            {saving ? "Enregistrement…" : "Enregistrer"}
          </button>
        </div>
      </div>
    </div>
  );
}
