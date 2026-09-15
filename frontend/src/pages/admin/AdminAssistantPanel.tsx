import { Bot, Check, Plus, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ASSISTANT_SIGNATURE, ASSISTANT_TITRE, type Message } from "../../components/AssistantPanel";
import { MarkdownContent } from "../../components/MarkdownContent";
import { getInitials } from "../../lib/initials";
import { streamAdminAsk } from "../../lib/streaming";
import {
  buildAdminAskPayload,
  extraireModifications,
  resumeEpreuveName,
  type AdminEpreuveSnapshot,
  type ModificationsEpreuve,
} from "../../lib/adminAssistant";

const INPUT_MAX_HEIGHT_PX = 120;

/**
 * Tiroir droit de l'assistant du back-office, ouvert depuis l'onglet
 * Épreuves. Conversations ÉPHÉMÈRES : la liste des messages vit dans
 * l'état du composant, perdue à la fermeture du tiroir ; le serveur ne
 * persiste RIEN (le flux n'envoie jamais de `conversation_id`).
 *
 * Le formulaire d'édition est resnapshotté à CHAQUE envoi : la prop `form`
 * (réactualisée par EpreuvesPanel à chaque frappe) est lue au moment de
 * l'appel de `send()` — jamais un instantané figé au moment de l'ouverture.
 */
export function AdminAssistantPanel({
  form,
  statut,
  onClose,
  onAppliquer,
}: {
  /** Formulaire d'édition COURANT (hors `statut`, porté par la prop éponyme). */
  form: Omit<AdminEpreuveSnapshot, "statut">;
  statut: string;
  onClose: () => void;
  /** Applique au formulaire d'édition une modification du sujet/corrigé
   * proposée par l'assistant (blocs `modification-sujet`/`modification-corrige`). */
  onAppliquer: (modifications: ModificationsEpreuve) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [erreurStream, setErreurStream] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Échap ferme le tiroir (même ergonomie que le panneau de l'élève).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus du champ de saisie dès l'ouverture — la frappe immédiate répond
  // sans clic supplémentaire.
  useEffect(() => {
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  // Descente automatique du fil à chaque renvoi/nouvel arrivage.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  // Le champ de saisie grandit avec son contenu (jusqu'à une hauteur
  // maximale, au-delà de laquelle il devient défilable).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT_PX)}px`;
  }, [input]);

  function nouvelleConversation() {
    setMessages([]);
    setErreurStream(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  /** Envoie la question à l'assistant admin en streaming. Charge utile
   * éphémère = question + historique + INSTANTANÉ FRAIS du formulaire. */
  async function send() {
    if (!input.trim() || sending) return;
    const question = input.trim();
    const payload = buildAdminAskPayload({ ...form, statut }, messages, question);
    setInput("");
    setSending(true);
    setErreurStream(null);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: question },
      { role: "assistant", content: "" },
    ]);

    // Fragments SSE tamponnés : appliqués une fois par frame (rAF) au lieu
    // de re-rendre à CHAQUE paquet réseau (même garde que l'assistant élève).
    let pendingChunkText = "";
    let chunkRaf: number | null = null;
    function flushChunk() {
      chunkRaf = null;
      if (!pendingChunkText) return;
      const fragment = pendingChunkText;
      pendingChunkText = "";
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        next[next.length - 1] = { ...last, content: last.content + fragment };
        return next;
      });
    }

    try {
      await streamAdminAsk(payload, (event) => {
        if (event.type === "chunk") {
          pendingChunkText += event.text;
          if (chunkRaf === null) chunkRaf = requestAnimationFrame(flushChunk);
        } else if (event.type === "done") {
          // Éphémère : `conversation` vaut null, rien à réconcilier — il
          // faut seulement vider le tampon avant de déclarer la fin.
          if (chunkRaf !== null) cancelAnimationFrame(chunkRaf);
          flushChunk();
        } else if (event.type === "error") {
          setErreurStream(event.message);
        }
      });
    } catch (err) {
      // Le rejet (ex. 401 sans session admin) vient de `streamAdminAsk`,
      // pas d'un évènement SSE — affiché comme erreur applicative.
      setErreurStream(err instanceof Error ? err.message : "Connexion au serveur interrompue.");
    } finally {
      setSending(false);
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Entrée seule envoie ; Maj+Entrée insère un saut de ligne.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <>
      {/* Fond assombri : un clic dessus ferme le tiroir. */}
      <div className="fixed inset-0 z-40 bg-ink/25" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ASSISTANT_TITRE}
        className="fixed inset-y-0 right-0 z-50 flex w-[min(420px,100vw)] flex-col bg-paper-raised text-ink shadow-xl"
      >
        <div className="border-b border-ink-soft/15 bg-paper px-4 pt-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="font-serif-brand text-sm leading-tight">{ASSISTANT_TITRE}</h2>
              <p className="font-mono-tag text-[10px] text-slate">
                {ASSISTANT_SIGNATURE} · back-office · éphémère (rien n'est enregistré)
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={nouvelleConversation}
                disabled={messages.length === 0 || sending}
                title="Nouvelle conversation (efface l'échange courant)"
                className="flex h-8 items-center gap-1 rounded-full border border-ink-soft/25 px-2.5 font-mono-tag text-[10px] text-ink-soft disabled:opacity-40"
              >
                <Plus size={12} strokeWidth={2} aria-hidden="true" />
                Nouvelle conversation
              </button>
              <button
                type="button"
                onClick={onClose}
                title="Fermer l'assistant"
                aria-label="Fermer l'assistant"
                className="p-1 text-ink-soft hover:text-ink"
              >
                <X size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          </div>
          {/* Bandeau contexte : rappelle QUELLE épreuve est snapshottée
              (le contenu réel est renvoyé à chaque envoi, jamais figé). */}
          <p className="mt-1.5 pb-2 font-mono-tag text-[10px] text-ink-soft">
            Contexte : épreuve en cours — {resumeEpreuveName({ ...form, statut })}
          </p>
        </div>

        <div
          ref={scrollRef}
          role="log"
          aria-label={`Discussion avec ${ASSISTANT_TITRE}`}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
        >
          {messages.length === 0 && !sending && (
            <div className="pt-6 text-center">
              <Bot size={28} strokeWidth={1.5} aria-hidden="true" className="mx-auto text-slate" />
              <p className="mt-2 text-sm font-medium">Pose ta première question</p>
              <p className="mt-1 text-xs text-slate">
                Reprends un exercice, vérifie le Markdown, ou demande une piste de corrigé pour cette épreuve.
              </p>
            </div>
          )}

          {messages.map((m, i) => {
            // Bulle d'assistant pré-créée VIDE pendant le streaming :
            // masquée, l'indicateur « génère… » la remplace.
            if (m.role === "assistant" && m.content === "" && sending && i === messages.length - 1) return null;
            return (
              <ChatBubble
                key={i}
                m={m}
                // Les boutons « Appliquer » n'apparaissent qu'une fois la
                // réponse terminée (le bloc de modification doit être complet).
                onAppliquer={
                  m.role === "assistant" && i === messages.length - 1 && !sending ? onAppliquer : undefined
                }
              />
            );
          })}

          {sending &&
            messages[messages.length - 1]?.role === "assistant" &&
            messages[messages.length - 1]?.content === "" && (
              <div className="flex items-end gap-2">
                <Avatar role="assistant" nom={ASSISTANT_SIGNATURE} />
                <p className="text-sm text-slate">{ASSISTANT_SIGNATURE} génère…</p>
              </div>
            )}

          {erreurStream && (
            <p
              role="status"
              className="rounded-lg border border-correction/30 bg-correction-soft px-3 py-2 text-sm text-correction"
            >
              {erreurStream} — relance ta question pour réessayer.
            </p>
          )}
        </div>

        <MessageComposer
          inputRef={inputRef}
          input={input}
          onChange={setInput}
          onKeyDown={onInputKeyDown}
          onSend={send}
          disabled={sending}
        />
      </div>
    </>
  );
}

/** Bulle de message : avatar + contenu Markdown (rounded-2xl réservé aux
 * bulles par le référentiel). Pour une réponse d'assistant terminée, des
 * boutons « Appliquer » apparaissent sous la bulle si elle contient des
 * blocs de modification (`modification-sujet`/`modification-corrige`) —
 * un clic remplit la zone de texte correspondante du formulaire. */
function ChatBubble({
  m,
  onAppliquer,
}: {
  m: Message;
  onAppliquer?: (modifications: ModificationsEpreuve) => void;
}) {
  const isUser = m.role === "user";
  // Les blocs de modification restent visibles dans le Markdown rendu
  // (aperçu) ; les boutons ne s'affichent que s'il y a un bloc exploitable.
  const modifs = m.role === "assistant" ? extraireModifications(m.content) : {};
  const applicable = Boolean(onAppliquer) && (modifs.sujet !== undefined || modifs.corrige !== undefined);
  return (
    <div className={`flex items-end gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <Avatar role={m.role} nom={isUser ? "Admin" : ASSISTANT_SIGNATURE} />
      <div className="min-w-0 max-w-[78%]">
        <p className={`mb-0.5 font-mono-tag text-[10px] text-slate ${isUser ? "text-right" : ""}`}>
          {isUser ? "Admin" : ASSISTANT_SIGNATURE}
        </p>
        <div
          className={`rounded-2xl px-3 py-2 ${
            isUser ? "bg-highlight-soft text-ink" : "border border-ink-soft/15 bg-paper text-ink"
          }`}
        >
          <MarkdownContent content={m.content} variant="chat" />
        </div>
        {applicable && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {modifs.sujet !== undefined && (
              <button
                type="button"
                onClick={() => onAppliquer!({ sujet: modifs.sujet })}
                className="flex min-h-[32px] items-center gap-1 rounded-full bg-valide px-3 text-xs font-medium text-paper"
              >
                <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                Appliquer au sujet
              </button>
            )}
            {modifs.corrige !== undefined && (
              <button
                type="button"
                onClick={() => onAppliquer!({ corrige: modifs.corrige })}
                className="flex min-h-[32px] items-center gap-1 rounded-full bg-valide px-3 text-xs font-medium text-paper"
              >
                <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                Appliquer au corrigé
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Champ de question + bouton d'envoi (mêmes conventions que le panneau
 * de l'élève : zone de texte → rayon `rounded-[2px]` du référentiel). */
function MessageComposer({
  inputRef,
  input,
  onChange,
  onKeyDown,
  onSend,
  disabled,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  input: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-end gap-2 border-t border-ink-soft/15 bg-paper p-3">
      <textarea
        ref={inputRef}
        value={input}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Pose ta question sur l'épreuve… (Maj+Entrée pour une nouvelle ligne)"
        aria-label={`Question à ${ASSISTANT_TITRE}`}
        rows={1}
        style={{ maxHeight: INPUT_MAX_HEIGHT_PX }}
        className="min-h-[44px] flex-1 resize-none overflow-y-auto rounded-[2px] border border-ink-soft/20 bg-paper-raised px-4 py-2.5 text-sm text-ink outline-none placeholder:text-slate"
      />
      <button
        type="button"
        onClick={onSend}
        disabled={disabled || !input.trim()}
        aria-label="Envoyer"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full verrou-highlight disabled:opacity-40"
      >
        <Send size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Avatar rond : initiales de l'admin côté utilisateur, icône robot pour
 * l'assistant (mêmes tokens adaptatifs que le panneau élève). */
function Avatar({ role, nom }: { role: "user" | "assistant"; nom: string }) {
  return (
    <div
      aria-hidden="true"
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
        role === "user" ? "bg-ink font-mono-tag text-[10px] font-semibold text-paper" : "bg-highlight text-highlight-ink"
      }`}
    >
      {role === "user" ? getInitials(nom) : <Bot size={14} strokeWidth={2} />}
    </div>
  );
}