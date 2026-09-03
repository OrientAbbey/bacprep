import { Bot, Maximize2, Minimize2, Plus, Send, User, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { streamAssistantAsk } from "../lib/streaming";
import { MarkdownContent } from "./MarkdownContent";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface Conversation {
  id: string;
  epreuve_id: string;
  label: string;
  contexte: string;
  messages: Message[];
  created_at: string;
  updated_at: string;
}

/** Signal envoyé par ViewerPage quand l'élève sélectionne un passage ALORS
 * que le panneau est déjà ouvert : le texte est collé dans le champ de
 * saisie de la discussion active (`nonce` change à chaque sélection pour
 * garantir que l'effet se redéclenche même si le texte est identique).
 * Ne touche JAMAIS au contexte de la discussion en cours. */
export interface PasteSignal {
  text: string;
  nonce: number;
}

const MAX_CONVERSATIONS = 5;
// Longueur au-delà de laquelle le contexte d'une discussion n'est plus
// affiché en entier dans la bulle "Passage sélectionné" (typiquement le
// contenu intégral de l'épreuve) — seul un aperçu est montré, le texte
// complet reste néanmoins transmis à l'assistant.
const CONTEXTE_PREVIEW_THRESHOLD = 500;
const CONTEXTE_PREVIEW_LENGTH = 320;
// Hauteur du champ de saisie multi-ligne : démarre à une ligne, grandit
// jusqu'à cette hauteur maximale avant de devenir défilable.
const INPUT_MAX_HEIGHT_PX = 120;

/**
 * Panneau de l'assistant. Suit le thème clair/sombre de la page et
 * n'assume plus sa propre position à l'écran dans le cas standard :
 * l'appelant (ViewerPage) le place soit dans une colonne latérale
 * (bureau), soit en feuille modale (mobile). Un troisième mode, plein
 * écran centré (`expanded`), est piloté par le bouton d'agrandissement du
 * panneau lui-même et prend le pas sur les deux autres.
 */
export function AssistantPanel({
  epreuveId,
  pendingContext,
  fullEpreuveContext,
  pasteSignal,
  onClose,
  mobile,
}: {
  epreuveId: string;
  pendingContext: string | null;
  /** Contenu Markdown complet de l'épreuve (onglet actif) — utilisé comme
   * contexte par défaut pour une discussion ouverte sans sélection
   * préalable ("Épreuve entière"), au lieu d'une chaîne vide. */
  fullEpreuveContext: string;
  /** Texte à coller dans le champ de saisie de la discussion active (voir
   * PasteSignal ci-dessus) — n'affecte jamais le contexte de la
   * discussion, contrairement à `pendingContext`. */
  pasteSignal: PasteSignal | null;
  onClose: () => void;
  mobile: boolean;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const active = conversations.find((c) => c.id === activeId) || null;

  // Garde contre le double-appel d'effet du mode strict de React (voir
  // commentaire détaillé dans une version antérieure — la ref persiste à
  // travers le double montage simulé de StrictMode et empêche de créer
  // deux discussions vides à la première ouverture).
  const initializedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (initializedForRef.current === epreuveId) return;
    initializedForRef.current = epreuveId;

    (async () => {
      setLoading(true);
      try {
        const convs = await api.get<Conversation[]>(`/api/epreuves/${epreuveId}/conversations`);
        setConversations(convs);

        if (pendingContext) {
          await createConversation(pendingContext, "Passage sélectionné");
        } else if (convs.length > 0) {
          setActiveId(convs[convs.length - 1].id);
        } else {
          // Aucune sélection préalable : le contexte par défaut est
          // l'épreuve entière (onglet actif), jamais une chaîne vide.
          await createConversation(fullEpreuveContext, "Épreuve entière");
        }
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epreuveId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.messages.length, active?.messages.reduce((acc, m) => acc + m.content.length, 0)]);

  // Fait défiler l'onglet actif dans la zone visible à chaque changement
  // (nouvel onglet créé, ou changement d'onglet actif) — sans ça, un
  // nouvel onglet ajouté au-delà de la largeur visible restait
  // sélectionné mais invisible tant qu'on ne faisait pas défiler
  // manuellement.
  useEffect(() => {
    if (!activeId) return;
    tabRefs.current.get(activeId)?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [activeId]);

  // Une nouvelle sélection de texte arrive pendant que le panneau est déjà
  // ouvert : elle est COLLÉE dans le champ de saisie (pas dans le contexte
  // de la discussion). Initialise la référence avec le nonce déjà présent
  // AU MONTAGE (plutôt que `null`) : bug corrigé — un panneau fraîchement
  // monté avec un `pasteSignal` déjà non-nul (valeur laissée par une
  // interaction précédente) le collait à tort dans le champ de saisie dès
  // l'ouverture, même sans nouvelle sélection. En capturant le nonce déjà
  // présent comme point de départ, seul un nonce VRAIMENT nouveau (reçu
  // après le montage) déclenche le collage.
  const lastPasteNonceRef = useRef<number | null>(pasteSignal?.nonce ?? null);
  useEffect(() => {
    if (!pasteSignal || pasteSignal.nonce === lastPasteNonceRef.current) return;
    lastPasteNonceRef.current = pasteSignal.nonce;

    const cleaned = pasteSignal.text.replace(/\s+/g, " ").trim();
    setInput((prev) => (prev ? `${prev} ${cleaned}` : cleaned));
    inputRef.current?.focus();
  }, [pasteSignal]);

  // Fait grandir le champ de saisie avec son contenu (jusqu'à une hauteur
  // maximale, au-delà de laquelle il devient défilable).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT_PX)}px`;
  }, [input]);

  async function createConversation(contexte: string, label: string) {
    if (conversations.length >= MAX_CONVERSATIONS) return;
    try {
      const conv = await api.post<Conversation>(`/api/epreuves/${epreuveId}/conversations`, {
        contexte,
        label,
      });
      setConversations((prev) => [...prev, conv]);
      setActiveId(conv.id);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) throw err;
    }
  }

  async function closeConversation(id: string) {
    await api.del(`/api/epreuves/${epreuveId}/conversations/${id}`);
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (activeId === id) setActiveId(next.length ? next[next.length - 1].id : null);
      return next;
    });
  }

  /** Envoie la question courante à l'assistant en streaming (activé par
   * défaut). Voir lib/streaming.ts pour le détail du protocole SSE. */
  async function send() {
    if (!active || !input.trim() || sending) return;
    const convId = active.id;
    const question = input.trim();
    setInput("");
    setSending(true);

    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? {
              ...c,
              messages: [...c.messages, { role: "user", content: question }, { role: "assistant", content: "" }],
            }
          : c
      )
    );

    function appendToLastAssistantMessage(fragment: string) {
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== convId) return c;
          const messages = [...c.messages];
          const last = messages[messages.length - 1];
          messages[messages.length - 1] = { ...last, content: last.content + fragment };
          return { ...c, messages };
        })
      );
    }

    try {
      await streamAssistantAsk(convId, question, (event) => {
        if (event.type === "chunk") {
          appendToLastAssistantMessage(event.text);
        } else if (event.type === "done") {
          setConversations((prev) => prev.map((c) => (c.id === event.conversation.id ? event.conversation : c)));
        } else if (event.type === "error") {
          appendToLastAssistantMessage(`\n\n*[${event.message}]*`);
        }
      });
    } catch {
      appendToLastAssistantMessage("\n\n*[Connexion au serveur interrompue.]*");
    } finally {
      setSending(false);
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Entrée seule envoie le message ; Maj+Entrée insère un saut de ligne
    // (convention standard des interfaces de discussion), nécessaire
    // maintenant que le champ est multi-ligne.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const contexteEstLong = (active?.contexte?.length ?? 0) > CONTEXTE_PREVIEW_THRESHOLD;
  const contexteAffiche =
    active?.contexte && contexteEstLong && !contextExpanded
      ? active.contexte.slice(0, CONTEXTE_PREVIEW_LENGTH) + "…"
      : active?.contexte;

  const containerClass = expanded
    ? "fixed inset-0 z-[60] m-auto flex h-[88vh] w-[min(760px,94vw)] flex-col rounded-2xl border border-ink-soft/15 bg-paper-raised text-ink shadow-2xl"
    : mobile
    ? "fixed inset-x-0 bottom-0 top-16 z-50 flex flex-col rounded-t-2xl border-t border-ink-soft/15 bg-paper-raised text-ink shadow-2xl"
    : "flex h-full w-full flex-col bg-paper-raised text-ink";

  return (
    <>
      {expanded && (
        <div
          className="fixed inset-0 z-[59] bg-ink/50 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
          aria-hidden="true"
        />
      )}
      <div className={containerClass}>
        {/* Grille plutôt que flex pour l'en-tête : `minmax(0,1fr)` garantit
            que la colonne des onglets peut réellement rétrécir sous sa
            largeur de contenu et défiler en interne — un piège classique
            de flexbox (`flex-1 min-w-0`) qui, selon les navigateurs et le
            contenu, pouvait laisser la ligne entière déborder au lieu de
            confiner le défilement au bon élément (bug corrigé : des
            onglets restaient inaccessibles, cachés derrière le bouton +). */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 border-b border-ink-soft/15 bg-paper px-3 py-2">
          {/* Barre de défilement des onglets : masquée au repos, révélée
              au survol de la souris (voir .scrollbar-hover dans index.css)
              — signale qu'il y a plus d'onglets accessibles par défilement
              sans encombrer l'en-tête en permanence. */}
          <div className="scrollbar-hover flex gap-2 overflow-x-auto">
            {conversations.map((c) => (
              <button
                key={c.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(c.id, el);
                  else tabRefs.current.delete(c.id);
                }}
                onClick={() => setActiveId(c.id)}
                className={`flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-xs ${
                  activeId === c.id ? "bg-highlight text-highlight-ink" : "bg-transparent text-ink-soft"
                }`}
              >
                <span className="max-w-[110px] truncate">{c.label}</span>
                <X
                  size={12}
                  strokeWidth={2}
                  aria-label={`Fermer la discussion ${c.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeConversation(c.id);
                  }}
                />
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={conversations.length >= MAX_CONVERSATIONS}
            onClick={() => createConversation(fullEpreuveContext, "Épreuve entière")}
            title="Nouvelle discussion"
            aria-label="Nouvelle discussion"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ink-soft/25 text-ink-soft disabled:opacity-40"
          >
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            title={expanded ? "Réduire" : "Agrandir la discussion"}
            aria-label={expanded ? "Réduire la discussion" : "Agrandir la discussion"}
            className="p-1 text-ink-soft hover:text-ink"
          >
            {expanded ? (
              <Minimize2 size={18} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Maximize2 size={18} strokeWidth={1.75} aria-hidden="true" />
            )}
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

        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4">
          {loading && <p className="text-sm text-slate">Chargement…</p>}

          {active?.contexte && (
            <div className="rounded-lg border-l-4 border-highlight bg-highlight-soft/40 px-3 py-2">
              <p className="mb-1 font-mono-tag text-[10px] text-ink-soft">
                {contexteEstLong ? "Contexte (épreuve entière)" : "Passage sélectionné"}
              </p>
              <div className="text-ink">
                <MarkdownContent content={contexteAffiche || ""} variant="chat" />
              </div>
              {contexteEstLong && (
                <button
                  type="button"
                  onClick={() => setContextExpanded((e) => !e)}
                  className="mt-1 font-mono-tag text-[10px] font-semibold text-ink underline decoration-highlight decoration-2 underline-offset-2"
                >
                  {contextExpanded ? "Réduire" : "Voir tout"}
                </button>
              )}
            </div>
          )}

          {active?.messages.map((m, i) => (
            <div
              key={i}
              className={`flex items-end gap-2 ${m.role === "user" ? "flex-row-reverse" : "flex-row"}`}
            >
              <Avatar role={m.role} />
              <div
                className={`max-w-[78%] min-w-0 rounded-2xl px-3 py-2 ${
                  m.role === "user"
                    ? "bg-highlight-soft text-ink"
                    : "border border-ink-soft/15 bg-paper text-ink"
                }`}
              >
                <MarkdownContent content={m.content} variant="chat" />
              </div>
            </div>
          ))}
          {sending &&
            active &&
            active.messages[active.messages.length - 1]?.role === "assistant" &&
            active.messages[active.messages.length - 1]?.content === "" && (
              <div className="flex items-end gap-2">
                <Avatar role="assistant" />
                <p className="text-sm text-slate">L'assistant réfléchit…</p>
              </div>
            )}
        </div>

        <div className="flex items-end gap-2 border-t border-ink-soft/15 bg-paper p-3">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Pose ta question… (Maj+Entrée pour une nouvelle ligne)"
            rows={1}
            style={{ maxHeight: INPUT_MAX_HEIGHT_PX }}
            className="min-h-[44px] flex-1 resize-none overflow-y-auto rounded-2xl border border-ink-soft/20 bg-paper-raised px-4 py-2.5 text-sm text-ink outline-none placeholder:text-slate"
          />
          <button
            type="button"
            onClick={send}
            disabled={sending || !input.trim()}
            aria-label="Envoyer"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-highlight text-highlight-ink hover:bg-highlight hover:text-highlight-ink focus-visible:bg-highlight focus-visible:text-highlight-ink disabled:opacity-40"
          >
            <Send size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>
    </>
  );
}

/** Avatar rond distinguant l'élève de l'assistant dans le fil de
 * discussion — l'un et l'autre utilisent des tokens de couleur adaptatifs
 * (jamais de fixe) pour rester lisibles dans les deux thèmes. */
function Avatar({ role }: { role: "user" | "assistant" }) {
  return (
    <div
      aria-hidden="true"
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
        role === "user" ? "bg-ink text-paper" : "bg-highlight text-highlight-ink"
      }`}
    >
      {role === "user" ? <User size={14} strokeWidth={2} /> : <Bot size={14} strokeWidth={2} />}
    </div>
  );
}
