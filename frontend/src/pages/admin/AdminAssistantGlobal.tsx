import { Bot, Check, Loader2, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import { MarkdownContent } from "../../components/MarkdownContent";
import { extraireActions, LIBELLES_OUTILS, type ActionProposee } from "../../lib/adminActions";
import { streamAdminAsk } from "../../lib/streaming";
import { authHeaders } from "./shared";

type EtatAction = "attente" | "en-cours" | "fait" | "ignoree" | "erreur";
interface Message {
  role: "user" | "assistant";
  content: string;
  actions?: { action: ActionProposee; etat: EtatAction; info?: string }[];
}

/**
 * Assistant du back-office pour TOUS les onglets (l'onglet Épreuves garde son
 * assistant d'édition). Il lit un résumé de l'onglet affiché, répond aux
 * questions et PROPOSE des actions : rien ne s'exécute sans le clic
 * « Confirmer » (liste blanche et validation côté serveur). Conversation
 * éphémère : rien n'est stocké.
 */
export function AdminAssistantGlobal({ token, onglet, onAction }: { token: string; onglet: string; onAction: () => void }) {
  const [ouvert, setOuvert] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [saisie, setSaisie] = useState("");
  const [enCours, setEnCours] = useState(false);
  const fin = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Corps de fonction (pas d'`=>` direct) : un effet ne doit RIEN renvoyer d'autre qu'un nettoyage.
    fin.current?.scrollIntoView?.({ block: "end" });
  }, [messages, ouvert]);

  const envoyer = async () => {
    const question = saisie.trim();
    if (!question || enCours) return;
    const historique = messages.map((m) => ({ role: m.role, content: m.content }));
    setSaisie("");
    setEnCours(true);
    setMessages((m) => [...m, { role: "user", content: question }, { role: "assistant", content: "" }]);
    let cumul = "";
    let erreur = "";
    try {
      await streamAdminAsk({ question, historique: [...historique, { role: "user", content: question }], epreuve: {}, onglet }, (e) => {
        if (e.type === "chunk") {
          cumul += e.text;
          setMessages((m) => [...m.slice(0, -1), { role: "assistant", content: cumul }]);
        } else if (e.type === "error") erreur = e.message;
      });
    } catch (e) {
      erreur = e instanceof ApiError && e.status === 429 ? "Trop de demandes — réessaie dans quelques minutes." : "L'assistant n'a pas pu répondre.";
    }
    const { texte, actions } = extraireActions(cumul);
    setMessages((m) => [
      ...m.slice(0, -1),
      { role: "assistant", content: erreur ? `⚠️ ${erreur}` : texte || "(réponse vide)", actions: actions.map((action) => ({ action, etat: "attente" as EtatAction })) },
    ]);
    setEnCours(false);
  };

  const majAction = (mi: number, ai: number, etat: EtatAction, info?: string) =>
    setMessages((ms) => ms.map((m, i) => (i !== mi ? m : { ...m, actions: m.actions?.map((a, j) => (j === ai ? { ...a, etat, info } : a)) })));

  const confirmer = async (mi: number, ai: number, a: ActionProposee) => {
    majAction(mi, ai, "en-cours");
    try {
      await api.post("/api/admin/assistant/execute", a, authHeaders(token));
      majAction(mi, ai, "fait");
      onAction();
    } catch (e) {
      const detail = e instanceof ApiError ? (typeof e.detail === "string" ? e.detail : "refusé") : "échec réseau";
      majAction(mi, ai, "erreur", detail);
    }
  };

  if (!ouvert)
    return (
      <button
        onClick={() => setOuvert(true)}
        className="fixed bottom-4 right-4 z-40 flex min-h-[48px] items-center gap-2 rounded-full bg-ink px-4 text-sm text-paper shadow-lg"
      >
        <Bot size={16} aria-hidden="true" /> Assistant
      </button>
    );

  return (
    <aside aria-label="Assistant du back-office" className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-ink-soft/20 bg-paper shadow-xl">
      <header className="flex items-center justify-between border-b border-ink-soft/15 px-4 py-3">
        <div>
          <h2 className="font-serif-brand text-base">Assistant du back-office</h2>
          <p className="font-mono-tag text-[10px] text-slate">ONGLET : {onglet.toUpperCase()}</p>
        </div>
        <button onClick={() => setOuvert(false)} aria-label="Fermer l'assistant" className="min-h-[44px] min-w-[44px]">
          <X size={18} className="mx-auto" />
        </button>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" role="log">
        {messages.length === 0 && (
          <p className="text-sm text-ink-soft">Pose une question sur cet onglet, ou demande une action (je te la proposerai, tu confirmes).</p>
        )}
        {messages.map((m, mi) => (
          <div key={mi} className={m.role === "user" ? "ml-8 rounded-lg bg-ink px-3 py-2 text-sm text-paper" : "mr-4 text-sm"}>
            {m.role === "user" ? m.content : m.content ? <MarkdownContent content={m.content} variant="chat" /> : <Loader2 size={14} className="animate-spin" aria-label="L'assistant réfléchit" />}
            {m.actions?.map((a, ai) => (
              <div key={ai} className="mt-2 rounded-lg border border-highlight/50 bg-highlight-soft/40 p-3">
                <p className="font-medium">{LIBELLES_OUTILS[a.action.outil] ?? a.action.outil}</p>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] text-ink-soft">{JSON.stringify(a.action.args, null, 2)}</pre>
                {a.etat === "attente" && (
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => confirmer(mi, ai, a.action)} className="flex min-h-[44px] items-center gap-1 rounded-full bg-ink px-4 text-paper">
                      <Check size={14} aria-hidden="true" /> Confirmer
                    </button>
                    <button onClick={() => majAction(mi, ai, "ignoree")} className="min-h-[44px] rounded-full border border-ink-soft/30 px-4">
                      Ignorer
                    </button>
                  </div>
                )}
                {a.etat === "en-cours" && <p className="mt-2 text-xs">Exécution…</p>}
                {a.etat === "fait" && <p role="status" className="mt-2 text-xs text-valide">✓ Action exécutée.</p>}
                {a.etat === "ignoree" && <p className="mt-2 text-xs text-slate">Ignorée.</p>}
                {a.etat === "erreur" && <p role="alert" className="mt-2 text-xs text-correction">Échec : {a.info}</p>}
              </div>
            ))}
          </div>
        ))}
        <div ref={fin} />
      </div>
      <form
        className="flex items-end gap-2 border-t border-ink-soft/15 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void envoyer();
        }}
      >
        <textarea
          value={saisie}
          onChange={(e) => setSaisie(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void envoyer();
            }
          }}
          rows={2}
          aria-label="Question à l'assistant"
          placeholder="Ex. Résous les signalements « autre » déjà traités…"
          className="min-h-[44px] flex-1 resize-none rounded border border-ink-soft/30 bg-paper px-2 py-1.5 text-sm"
        />
        <button type="submit" disabled={enCours || !saisie.trim()} aria-label="Envoyer" className="min-h-[44px] min-w-[44px] rounded-full bg-ink text-paper disabled:opacity-50">
          <Send size={16} className="mx-auto" />
        </button>
      </form>
    </aside>
  );
}
