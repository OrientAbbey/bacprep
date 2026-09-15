import { Bot, Check, Clock, Pencil, Plus, RotateCcw, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ASSISTANT_SIGNATURE, ASSISTANT_TITRE, type Message } from "../../components/AssistantPanel";
import { MarkdownContent } from "../../components/MarkdownContent";
import { dateLongue, heureCourte } from "../../lib/dates";
import { getInitials } from "../../lib/initials";
import { delaiReconnexion, streamAdminAsk } from "../../lib/streaming";
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
 * l'appel de l'envoi — jamais un instantané figé au moment de l'ouverture.
 *
 * Fonctionnalités communes aux deux assistants : streaming SSE avec
 * RECONNEXION AUTOMATIQUE (le flux est relancé tel quel, délai croissant,
 * si la connexion s'interrompt sans `done`), horodatage HH:MM des messages
 * (date complète au survol), file d'attente (envoyer pendant une réponse
 * met la question en attente), édition inline d'une question + régénération
 * depuis ce point, et relance de la dernière question en un clic.
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
  const [queue, setQueue] = useState<string[]>([]);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Ref miroir de `messages` : les effects de file d'attente / reconnexion
  // doivent lire l'état le plus récent, jamais une closure figée.
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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
    setQueue([]);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  /** Soumission depuis le champ de saisie : si une réponse est déjà en
   * cours, la question part en FILE D'ATTENTE (envoyée automatiquement dès
   * la fin de la réponse en cours) au lieu d'être ignorée. */
  function submitQuestion() {
    const text = input.trim();
    if (!text) return;
    if (sending) {
      setQueue((q) => [...q, text]);
      setInput("");
      return;
    }
    setInput("");
    void applyExchange(text, messagesRef.current);
  }

  // Dépilement automatique de la file d'attente.
  useEffect(() => {
    if (sending || queue.length === 0) return;
    const [prochaine, ...restantes] = queue;
    setQueue(restantes);
    void applyExchange(prochaine, messagesRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending, queue]);

  /** Exécute UN échange complet (question → réponse streamée). `base` =
   * l'état des messages AVANT la question. Rejoignable automatiquement :
   * si le flux s'interrompt SANS `done`, la charge utile FIGÉE du premier
   * envoi (instantané du formulaire inclus) est relancée telle quelle
   * après un délai croissant, jusqu'à 3 tentatives. Les erreurs
   * applicatives du flux et les 4xx ne sont pas relancées. */
  async function applyExchange(question: string, base: Message[]) {
    if (sending) return;
    const payload = buildAdminAskPayload({ ...form, statut }, base, question);
    const nowIso = new Date().toISOString();

    setMessages([...base, { role: "user", content: question, ts: nowIso }, { role: "assistant", content: "", ts: nowIso }]);
    setSending(true);
    setErreurStream(null);

    const MAX_ATTEMPTES = 3;
    let erreurFinale: string | null = null;
    let aReussi = false;

    for (let tentative = 1; tentative <= MAX_ATTEMPTES; tentative++) {
      let gotDone = false;
      let gotErrorEvent = false;
      let pendingChunkText = "";
      let chunkRaf: number | null = null;

      // Fragments SSE tamponnés : appliqués une fois par frame (rAF) au
      // lieu de re-rendre à CHAQUE paquet réseau (même garde que
      // l'assistant élève). `flushChunk` est forcé avant la clôture.
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

      if (tentative > 1) {
        // Nouvelle tentative : toute réponse partielle est remise à zéro.
        setMessages((prev) => [
          ...prev.slice(0, -1),
          { role: "assistant", content: "", ts: new Date().toISOString() },
        ]);
        setReconnectAttempt(tentative);
      }

      try {
        await streamAdminAsk(payload, (event) => {
          if (event.type === "chunk") {
            pendingChunkText += event.text;
            if (chunkRaf === null) chunkRaf = requestAnimationFrame(flushChunk);
          } else if (event.type === "done") {
            gotDone = true;
            // Éphémère : `conversation` vaut null, rien à réconcilier — il
            // faut seulement vider le tampon avant de déclarer la fin.
            if (chunkRaf !== null) cancelAnimationFrame(chunkRaf);
            flushChunk();
          } else if (event.type === "error") {
            gotErrorEvent = true;
            erreurFinale = event.message;
          }
        });
      } catch (err) {
        const status = (err as Error & { status?: number })?.status;
        if (typeof status === "number" && status >= 400 && status < 500) {
          erreurFinale = err instanceof Error ? err.message : "Requête refusée.";
          break;
        }
        erreurFinale =
          err instanceof TypeError ? "Connexion au serveur interrompue." : err instanceof Error ? err.message : "Connexion interrompue pendant la réponse.";
      }

      if (gotDone) {
        aReussi = true;
        break;
      }
      if (gotErrorEvent) break;

      if (tentative < MAX_ATTEMPTES) {
        await new Promise((r) => setTimeout(r, delaiReconnexion(tentative)));
      }
    }

    setReconnectAttempt(0);
    setSending(false);
    if (!aReussi) {
      setErreurStream(erreurFinale ?? "La réponse n'a pas pu être reçue — réessaie.");
    }
  }

  /** Réessaye la DERNIÈRE réponse : retire le dernier échange et renvoie
   * la même question. */
  function retryLast() {
    if (sending) return;
    const msgs = messagesRef.current;
    const dernier = msgs[msgs.length - 1];
    if (!dernier || dernier.role !== "assistant") return;
    const question = msgs[msgs.length - 2];
    if (!question || question.role !== "user") return;
    void applyExchange(question.content, msgs.slice(0, -2));
  }

  /** Édition d'une question + régénération à partir de ce point : la
   * conversation est tronquée avant le message édité, qui est renvoyé tel
   * quel. */
  function regenerateFrom(index: number, contenu: string) {
    if (sending) return;
    const msgs = messagesRef.current;
    if (!msgs[index] || msgs[index].role !== "user") return;
    void applyExchange(contenu, msgs.slice(0, index));
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Entrée seule envoie (ou met en file d'attente) ; Maj+Entrée insère
    // un saut de ligne.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitQuestion();
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
                className="relative flex h-8 items-center gap-1 rounded-full border border-ink-soft/25 px-2.5 font-mono-tag text-[10px] text-ink-soft after:absolute after:-inset-1.5 after:rounded-full after:content-[''] disabled:opacity-40"
              >
                <Plus size={12} strokeWidth={2} aria-hidden="true" />
                Nouvelle conversation
              </button>
              <button
                type="button"
                onClick={onClose}
                title="Fermer l'assistant"
                aria-label="Fermer l'assistant"
                className="relative p-1 text-ink-soft hover:text-ink after:absolute after:-inset-[9px] after:content-['']"
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
            const estDernier = i === messages.length - 1;
            return (
              <ChatBubble
                key={`${m.role}-${i}`}
                m={m}
                // Les boutons « Appliquer » n'apparaissent qu'une fois la
                // réponse terminée (le bloc de modification doit être complet).
                onAppliquer={
                  m.role === "assistant" && estDernier && !sending ? onAppliquer : undefined
                }
                estDernier={estDernier}
                enCours={sending}
                onEditer={m.role === "user" && !sending ? (contenu) => regenerateFrom(i, contenu) : undefined}
                onRegenerer={
                  m.role === "assistant" && !sending && estDernier ? retryLast : undefined
                }
              />
            );
          })}

          {sending &&
            messages[messages.length - 1]?.role === "assistant" &&
            messages[messages.length - 1]?.content === "" && (
              <div className="flex items-end gap-2">
                <Avatar role="assistant" nom={ASSISTANT_SIGNATURE} />
                <p className="text-sm text-slate">
                  {reconnectAttempt > 0
                    ? `Connexion instable — reconnexion (${reconnectAttempt}/3)…`
                    : `${ASSISTANT_SIGNATURE} génère…`}
                </p>
              </div>
            )}

          {erreurStream && (
            <p
              role="status"
              className="rounded-lg border border-correction/30 bg-correction-soft px-3 py-2 text-sm text-correction"
            >
              {erreurStream}
            </p>
          )}
        </div>

        <MessageComposer
          inputRef={inputRef}
          input={input}
          onChange={setInput}
          onKeyDown={onInputKeyDown}
          onSend={submitQuestion}
          queueCount={queue.length}
        />
      </div>
    </>
  );
}

/** Bulle de message : avatar + auteur + horodatage (HH:MM, date complète
 * au survol) + contenu Markdown (rounded-2xl réservé aux bulles par le
 * référentiel). Pour une réponse d'assistant terminée, des boutons
 * « Appliquer » apparaissent sous la bulle si elle contient des blocs de
 * modification (`modification-sujet`/`modification-corrige`) — un clic
 * remplit la zone de texte correspondante du formulaire. Les questions
 * de l'admin sont éditables (« Modifier ») et la dernière réponse peut
 * être relancée (« Réessayer »). */
function ChatBubble({
  m,
  onAppliquer,
  estDernier,
  enCours,
  onEditer,
  onRegenerer,
}: {
  m: Message;
  onAppliquer?: (modifications: ModificationsEpreuve) => void;
  estDernier: boolean;
  enCours: boolean;
  onEditer?: (contenu: string) => void;
  onRegenerer?: () => void;
}) {
  const isUser = m.role === "user";
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(m.content);
  // Les blocs de modification restent visibles dans le Markdown rendu
  // (aperçu) ; les boutons ne s'affichent que s'il y a un bloc exploitable.
  const modifs = m.role === "assistant" ? extraireModifications(m.content) : {};
  const applicable = Boolean(onAppliquer) && (modifs.sujet !== undefined || modifs.corrige !== undefined);

  const heure = heureCourte(m.ts);
  const titreDate = dateLongue(m.ts);

  function demarrerEdition() {
    setEditValue(m.content);
    setEditing(true);
  }

  function validerEdition() {
    const contenu = editValue.trim();
    if (!contenu) return;
    setEditing(false);
    onEditer?.(contenu);
  }

  return (
    <div className={`flex items-end gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <Avatar role={m.role} nom={isUser ? "Admin" : ASSISTANT_SIGNATURE} />
      <div className="min-w-0 max-w-[78%]">
        <p className={`mb-0.5 flex items-center gap-1.5 font-mono-tag text-[10px] text-slate ${isUser ? "flex-row-reverse" : ""}`}>
          <span>{isUser ? "Admin" : ASSISTANT_SIGNATURE}</span>
          {heure && (
            <span title={titreDate ?? undefined} className="text-slate/70">
              {heure}
            </span>
          )}
        </p>
        {editing ? (
          <div className="rounded-2xl border border-ink-soft/15 bg-paper px-3 py-2">
            <textarea
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              rows={3}
              aria-label="Modifier ta question"
              className="w-full resize-y rounded-[2px] border border-ink-soft/20 bg-paper-raised px-3 py-2 text-sm text-ink outline-none"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={validerEdition}
                disabled={!editValue.trim()}
                className="inline-flex min-h-[44px] items-center gap-1 rounded-full bg-valide px-4 text-xs font-medium text-paper disabled:opacity-40"
              >
                <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                Valider
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="inline-flex min-h-[44px] items-center gap-1 rounded-full border border-ink-soft/25 px-4 text-xs text-ink-soft hover:text-ink"
              >
                Annuler
              </button>
            </div>
          </div>
        ) : (
          <div
            className={`rounded-2xl px-3 py-2 ${
              isUser ? "bg-highlight-soft text-ink" : "border border-ink-soft/15 bg-paper text-ink"
            }`}
          >
            <MarkdownContent content={m.content} variant="chat" />
          </div>
        )}
        {!editing && applicable && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {modifs.sujet !== undefined && (
              <button
                type="button"
                onClick={() => onAppliquer!({ sujet: modifs.sujet })}
                className="flex min-h-[44px] items-center gap-1 rounded-full bg-valide px-3 text-xs font-medium text-paper"
              >
                <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                Appliquer au sujet
              </button>
            )}
            {modifs.corrige !== undefined && (
              <button
                type="button"
                onClick={() => onAppliquer!({ corrige: modifs.corrige })}
                className="flex min-h-[44px] items-center gap-1 rounded-full bg-valide px-3 text-xs font-medium text-paper"
              >
                <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                Appliquer au corrigé
              </button>
            )}
          </div>
        )}
        {!editing && (
          <div className="mt-0.5 flex flex-wrap gap-x-3">
            {isUser && onEditer && (
              <button
                type="button"
                onClick={demarrerEdition}
                title="Modifier ta question et régénérer la réponse"
                className="relative inline-flex items-center gap-1 font-mono-tag text-[10px] text-slate hover:text-ink after:absolute after:-inset-[10px] after:content-['']"
              >
                <Pencil size={11} strokeWidth={1.75} aria-hidden="true" />
                Modifier
              </button>
            )}
            {!isUser && estDernier && onRegenerer && !enCours && (
              <button
                type="button"
                onClick={onRegenerer}
                title="Relancer la même question"
                className="relative inline-flex items-center gap-1 font-mono-tag text-[10px] text-slate hover:text-ink after:absolute after:-inset-[10px] after:content-['']"
              >
                <RotateCcw size={11} strokeWidth={1.75} aria-hidden="true" />
                Réessayer
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Champ de question + bouton d'envoi (mêmes conventions que le panneau
 * de l'élève : zone de texte → rayon `rounded-[2px]` du référentiel).
 * Pendant une réponse, l'envoi reste actif : la question part en file
 * d'attente, signalée au-dessus du champ. */
function MessageComposer({
  inputRef,
  input,
  onChange,
  onKeyDown,
  onSend,
  queueCount,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  input: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  queueCount: number;
}) {
  return (
    <div className="border-t border-ink-soft/15 bg-paper">
      {queueCount > 0 && (
        <p role="status" className="flex items-center gap-1.5 px-4 pt-2 font-mono-tag text-[10px] text-slate">
          <Clock size={11} strokeWidth={1.75} aria-hidden="true" />
          {queueCount} question{queueCount > 1 ? "s" : ""} en attente…
        </p>
      )}
      <div className="flex items-end gap-2 p-3">
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
          disabled={!input.trim()}
          aria-label="Envoyer"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full verrou-highlight disabled:opacity-40"
        >
          <Send size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
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