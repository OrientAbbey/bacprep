import { Bot, Check, Pencil, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api, ApiError } from "../../api/client";
import {
  ASSISTANT_SIGNATURE,
  ASSISTANT_TITRE,
  Avatar,
  ChatBubble,
  INPUT_MAX_HEIGHT_PX,
  MessageComposer,
  type Message as MessageChat,
} from "../../components/ChatParts";
import { extraireActions, LIBELLES_OUTILS, type ActionProposee } from "../../lib/adminActions";
import { appliquerChampsAdmin, lireContexteAdmin, ouvrirFormulaireAdmin } from "../../lib/adminContexte";
import {
  aDesModifications,
  applicationAutoInitiale,
  buildAdminAskPayload,
  extraireModifications,
  memoriserApplicationAuto,
  resumeEpreuveName,
  type AdminEpreuveSnapshot,
  type ModificationsEpreuve,
} from "../../lib/adminAssistant";
import {
  chargerConversationAdmin,
  delaiReconnexion,
  effacerConversationAdmin,
  streamAdminAsk,
} from "../../lib/streaming";
import { authHeaders } from "./shared";

type EtatAction = "attente" | "en-cours" | "fait" | "ignoree" | "erreur";

interface Plan {
  actions: ActionProposee[];
  jeton: string;
  etat: EtatAction;
  ignorees?: number[];
  erreur?: string;
}

interface MessageAdmin extends MessageChat {
  plan?: Plan;
  formulaires?: string[];
  editions?: string[];
  annulerEditions?: Record<string, unknown>;
}

/**
 * Assistant unique du back-office. DEUX modes, UNE interface :
 *
 * - `onglet === "epreuves"` : co-rédaction de l'épreuve en cours. Le formulaire
 *   est re-snapshotté à chaque envoi ; les blocs `modification-*` sont appliqués
 *   automatiquement (bascule) ou via « Appliquer au sujet/corrigé/formulaire ».
 * - tous les autres onglets : agent transverse. Il ouvre et remplit un
 *   formulaire (`formulaire`/`edition`) et propose un plan d'actions signé
 *   soumis à l'approbation de l'admin (`/proposition` + `/commit`).
 *
 * Fonctionnalités communes : streaming SSE avec reconnexion automatique,
 * file d'attente, horodatage, édition inline d'une question + régénération,
 * relance de la dernière question, mémorisation de la discussion par clé.
 */
/** Assistant unique du back-office : édition de texte sur Épreuves, agent à plan approuvé sur les autres onglets. */
export function AdminAssistantPanel({
  token,
  onglet,
  onClose,
  onAction,
  form,
  statut,
  conversationId,
  onAppliquer,
  onAnnuler,
  sujetActifRang,
}: {
  /** Jeton admin, nécessaire au mode agent (plan /commit). */
  token?: string;
  /** Onglet courant du back-office. Détermine le mode. */
  onglet: string;
  onClose: () => void;
  /** Rafraîchit le panneau après l'exécution d'un plan (mode agent). */
  onAction?: () => void;
  /** Mode édition uniquement : instantané du formulaire et callbacks. */
  form?: Omit<AdminEpreuveSnapshot, "statut">;
  statut?: string;
  conversationId?: string;
  onAppliquer?: (modifications: ModificationsEpreuve) => boolean;
  onAnnuler?: () => void;
  sujetActifRang?: number;
}) {
  const estEdition = onglet === "epreuves";
  const cle = estEdition ? conversationId ?? "brouillon:epreuves" : `onglet:${onglet}`;

  const [messages, setMessages] = useState<MessageAdmin[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [erreurStream, setErreurStream] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [enChargement, setEnChargement] = useState(false);
  const [auto, setAuto] = useState(applicationAutoInitiale);
  const [appliqueAuto, setAppliqueAuto] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const messagesRef = useRef<MessageAdmin[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const onAppliquerRef = useRef(onAppliquer);
  const autoRef = useRef(auto);
  useEffect(() => {
    onAppliquerRef.current = onAppliquer;
    autoRef.current = auto;
  });

  const abortRef = useRef<AbortController | null>(null);
  const chunkRafRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (chunkRafRef.current !== null) cancelAnimationFrame(chunkRafRef.current);
    };
  }, []);

  // Recharge la discussion de CET onglet / CETTE épreuve ; le changement de
  // brouillon vers épreuve enregistrée change la clé et recharge la mémoire.
  useEffect(() => {
    let annule = false;
    setEnChargement(true);
    setMessages([]);
    setErreurStream(null);
    void chargerConversationAdmin(cle).then((conversation) => {
      if (annule) return;
      if (conversation) {
        setMessages(
          conversation.messages.map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: estEdition ? m.content : extraireActions(m.content).texte || "(action proposée)",
            ts: m.ts,
          }))
        );
      }
      setEnChargement(false);
    });
    return () => {
      annule = true;
    };
  }, [cle, estEdition]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT_PX)}px`;
  }, [input]);

  function nouvelleConversation() {
    if (sending) return;
    setMessages([]);
    setErreurStream(null);
    setQueue([]);
    void effacerConversationAdmin(cle);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

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

  useEffect(() => {
    if (sending || queue.length === 0) return;
    const [prochaine, ...restantes] = queue;
    setQueue(restantes);
    void applyExchange(prochaine, messagesRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending, queue]);

  async function applyExchange(question: string, base: MessageAdmin[]) {
    if (sending) return;
    const contexte = estEdition ? null : lireContexteAdmin(onglet);
    const historique = base.map(({ role, content }) => ({ role, content }));
    const payload = estEdition
      ? buildAdminAskPayload(
          { ...(form as Omit<AdminEpreuveSnapshot, "statut">), statut: statut ?? "" },
          historique,
          question,
          conversationId,
          sujetActifRang
        )
      : {
          question,
          historique,
          epreuve: {},
          onglet,
          agent: true,
          ...(contexte ? { contexte } : {}),
        };

    const nowIso = new Date().toISOString();
    setMessages([
      ...base,
      { role: "user", content: question, ts: nowIso },
      { role: "assistant", content: "", ts: nowIso },
    ]);
    setSending(true);
    setErreurStream(null);
    setAppliqueAuto(false);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    const MAX_ATTEMPTES = 3;
    let erreurFinale: string | null = null;
    let reponse = "";
    let aReussi = false;
    let annule = false;
    let plan: Plan | null = null;
    const ciblesRecues: string[] = [];
    const editionsRecues: Record<string, unknown>[] = [];

    for (let tentative = 1; tentative <= MAX_ATTEMPTES; tentative++) {
      if (signal.aborted) {
        annule = true;
        break;
      }
      let gotDone = false;
      let gotErrorEvent = false;
      let pendingChunkText = "";
      let chunkRaf: number | null = null;

      function flushChunk() {
        chunkRaf = null;
        chunkRafRef.current = null;
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

      reponse = "";
      if (tentative > 1) {
        setMessages((prev) => [
          ...prev.slice(0, -1),
          { role: "assistant", content: "", ts: new Date().toISOString() },
        ]);
        setReconnectAttempt(tentative);
      }

      try {
        await streamAdminAsk(
          payload,
          (event) => {
            if (event.type === "chunk") {
              reponse += event.text;
              pendingChunkText += event.text;
              if (chunkRaf === null) {
                chunkRaf = requestAnimationFrame(flushChunk);
                chunkRafRef.current = chunkRaf;
              }
            } else if (event.type === "formulaire") {
              ciblesRecues.push(event.cible);
            } else if (event.type === "edition") {
              editionsRecues.push(event.champs);
            } else if (event.type === "proposition") {
              plan = { actions: event.actions, jeton: event.jeton, etat: "attente", ignorees: [] };
            } else if (event.type === "done") {
              gotDone = true;
              if (chunkRaf !== null) {
                cancelAnimationFrame(chunkRaf);
                chunkRafRef.current = null;
              }
              flushChunk();
              if (event.conversation) {
                reponse = event.conversation.messages[event.conversation.messages.length - 1]?.content ?? reponse;
                setMessages(
                  event.conversation.messages.map((m) => ({
                    role: m.role === "assistant" ? "assistant" : "user",
                    content: estEdition ? m.content : extraireActions(m.content).texte || "(action proposée)",
                    ts: m.ts,
                  }))
                );
              }
            } else if (event.type === "error") {
              gotErrorEvent = true;
              erreurFinale = event.message;
            }
          },
          signal
        );
      } catch (err) {
        if (signal.aborted || (err as Error)?.name === "AbortError") {
          annule = true;
          break;
        }
        const status = (err as Error & { status?: number })?.status;
        if (typeof status === "number" && status >= 400 && status < 500) {
          erreurFinale = err instanceof Error ? err.message : "Requête refusée.";
          break;
        }
        erreurFinale =
          err instanceof TypeError
            ? "Connexion au serveur interrompue."
            : err instanceof Error
              ? err.message
              : "Connexion interrompue pendant la réponse.";
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

    if (annule) return;
    if (abortRef.current === controller) abortRef.current = null;
    setReconnectAttempt(0);
    setSending(false);
    if (!aReussi) {
      setErreurStream(erreurFinale ?? "La réponse n'a pas pu être reçue — réessaie.");
      return;
    }

    let planFinal: Plan | null = plan;
    let formulairesOuverts: string[] = [];
    let nomsEditions: string[] = [];
    let avant: Record<string, unknown> = {};
    let erreurAgent = "";

    if (estEdition) {
      if (autoRef.current) {
        const modifications = extraireModifications(reponse);
        if (aDesModifications(modifications)) setAppliqueAuto(onAppliquerRef.current?.(modifications) ?? false);
      }
    } else {
      // L'agent peut ouvrir un formulaire avant de le remplir. flushSync
      // garantit que le panneau a rendu le formulaire (et publié son contexte)
      // avant que les éditions ne soient appliquées.
      flushSync(() => {
        for (const cible of ciblesRecues) {
          if (ouvrirFormulaireAdmin(onglet, cible)) formulairesOuverts.push(cible);
        }
        if (editionsRecues.length && formulairesOuverts.length === 0) {
          for (const cible of ["exercice", "partie", "formule", "evenement", "notification", "option"]) {
            if (ouvrirFormulaireAdmin(onglet, cible)) {
              formulairesOuverts.push(cible);
              break;
            }
          }
        }
      });
      if (formulairesOuverts.length || editionsRecues.length) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const contexteAvant = lireContexteAdmin(onglet)?.formulaire as Record<string, unknown> | undefined;
        if (contexteAvant && typeof contexteAvant === "object") {
          for (const [cleChamp, valeur] of Object.entries(contexteAvant)) {
            if (["string", "number", "boolean"].includes(typeof valeur)) avant[cleChamp] = valeur;
          }
        }
      }
      const editionsAppliquees = editionsRecues.length > 0 && appliquerChampsAdmin(onglet, editionsRecues);
      if (editionsRecues.length && !editionsAppliquees) {
        erreurAgent = "Champs proposés, mais aucun formulaire n'est ouvert dans ce panneau.";
      }
      // Compatibilité : une réponse « historique » peut encore contenir des
      // blocs ```action``` ; on les regroupe en plan avec un jeton neuf.
      if (!planFinal) {
        const actionsTexte = extraireActions(reponse).actions;
        if (actionsTexte.length) {
          try {
            const reponseJeton = await api.post<{ jeton: string }>(
              "/api/admin/assistant/proposition",
              actionsTexte,
              authHeaders(token ?? "")
            );
            planFinal = { actions: actionsTexte, jeton: reponseJeton.jeton, etat: "attente", ignorees: [] };
          } catch {
            planFinal = { actions: actionsTexte, jeton: "", etat: "attente", ignorees: [] };
          }
        }
      }
      nomsEditions = editionsRecues.flatMap((champs) => Object.keys(champs));
    }

    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role !== "assistant") return next;
      next[next.length - 1] = {
        ...last,
        content: estEdition
          ? last.content
          : erreurAgent
            ? `⚠️ ${erreurAgent}`
            : extraireActions(last.content).texte ||
              (planFinal
                ? "(plan d'actions proposé)"
                : nomsEditions.length
                  ? "(champs du formulaire remplis)"
                  : "(réponse vide)"),
        plan: planFinal ?? undefined,
        formulaires: formulairesOuverts.length ? formulairesOuverts : undefined,
        editions: nomsEditions.length ? nomsEditions : undefined,
        annulerEditions: nomsEditions.length ? avant : undefined,
      };
      return next;
    });
  }

  function retryLast() {
    if (sending) return;
    const msgs = messagesRef.current;
    const dernier = msgs[msgs.length - 1];
    if (!dernier || dernier.role !== "assistant") return;
    const question = msgs[msgs.length - 2];
    if (!question || question.role !== "user") return;
    void applyExchange(question.content, msgs.slice(0, -2));
  }

  function regenerateFrom(index: number, contenu: string) {
    if (sending) return;
    const msgs = messagesRef.current;
    if (!msgs[index] || msgs[index].role !== "user") return;
    void applyExchange(contenu, msgs.slice(0, index));
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitQuestion();
    }
  }

  const majPlan = (mi: number, changements: Partial<Plan>) =>
    setMessages((ms) =>
      ms.map((m, i) => (i !== mi || !m.plan ? m : { ...m, plan: { ...m.plan, ...changements } }))
    );

  const annulerEditions = (mi: number) =>
    setMessages((ms) =>
      ms.map((m, i) => (i !== mi ? m : { ...m, editions: undefined, annulerEditions: undefined }))
    );

  async function approuver(mi: number) {
    const message = messages[mi];
    const plan = message?.plan;
    if (!plan || plan.etat !== "attente") return;
    const ignorees = plan.ignorees ?? [];
    const actions = plan.actions.filter((_, i) => !ignorees.includes(i));
    majPlan(mi, { etat: "en-cours" });
    try {
      const r = await api.post<{ ok: boolean; resultats: { ok: boolean; erreur?: string }[] }>(
        "/api/admin/assistant/commit",
        { jeton: plan.jeton, actions },
        authHeaders(token ?? "")
      );
      const echecs = r.resultats.filter((x) => !x.ok);
      majPlan(mi, { etat: echecs.length ? "erreur" : "fait", erreur: echecs.map((x) => x.erreur).join(" ; ") });
      onAction?.();
    } catch (e) {
      const detail = e instanceof ApiError ? (typeof e.detail === "string" ? e.detail : "refusé") : "échec réseau";
      majPlan(mi, { etat: "erreur", erreur: detail });
    }
  }

  const rejeter = (mi: number) => majPlan(mi, { etat: "ignoree" });

  async function ignorerAction(mi: number, ai: number) {
    const plan = messages[mi]?.plan;
    if (!plan) return;
    const ignorees = [...new Set([...(plan.ignorees ?? []), ai])];
    const actions = plan.actions.filter((_, i) => !ignorees.includes(i));
    let jeton = plan.jeton;
    if (actions.length) {
      try {
        jeton = (
          await api.post<{ jeton: string }>(
            "/api/admin/assistant/proposition",
            actions,
            authHeaders(token ?? "")
          )
        ).jeton;
      } catch {
        jeton = "";
      }
    }
    majPlan(mi, { ignorees, jeton });
  }

  async function editerAction(mi: number, ai: number, texte: string) {
    const plan = messages[mi]?.plan;
    if (!plan) return;
    try {
      const objet = JSON.parse(texte) as { outil?: string; args?: Record<string, unknown> };
      if (typeof objet.outil !== "string" || !objet.args) throw new Error('Format : {"outil": "…", "args": {…}}');
      const actions = plan.actions.map((a, i) => (i === ai ? { outil: objet.outil!, args: objet.args! } : a));
      const reponse = await api.post<{ jeton: string }>(
        "/api/admin/assistant/proposition",
        actions,
        authHeaders(token ?? "")
      );
      majPlan(mi, { actions, jeton: reponse.jeton, etat: "attente" });
    } catch (e) {
      majPlan(mi, { etat: "erreur", erreur: e instanceof Error ? e.message : "JSON invalide" });
    }
  }

  return (
    <>
      {/* En mode agent, pas de fond bloquant : l'admin doit pouvoir changer
          d'onglet pendant que le tiroir reste ouvert (mémoire par onglet). */}
      {estEdition && <div className="fixed inset-0 z-40 bg-ink/25" onClick={onClose} aria-hidden="true" />}
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
                {ASSISTANT_SIGNATURE} · back-office · discussion enregistrée
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
          <p className="mt-1.5 pb-2 font-mono-tag text-[10px] text-ink-soft">
            {estEdition
              ? `Contexte : épreuve en cours — ${resumeEpreuveName({ ...(form as Omit<AdminEpreuveSnapshot, "statut">), statut: statut ?? "" })}`
              : `ONGLET : ${onglet.toUpperCase()}`}
          </p>
        </div>

        <div
          ref={scrollRef}
          role="log"
          aria-label={`Discussion avec ${ASSISTANT_TITRE}`}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
        >
          {enChargement && (
            <div className="pt-6 text-center">
              <p className="text-sm text-slate">Chargement de la discussion…</p>
            </div>
          )}

          {messages.length === 0 && !sending && !enChargement && (
            <div className="pt-6 text-center">
              <Bot size={28} strokeWidth={1.5} aria-hidden="true" className="mx-auto text-slate" />
              <p className="mt-2 text-sm font-medium">Pose ta première question</p>
              <p className="mt-1 text-xs text-slate">
                {estEdition
                  ? "Reprends un exercice, vérifie le Markdown, ou demande une piste de corrigé pour cette épreuve."
                  : "Pose une question sur cet onglet : l'agent peut remplir le formulaire, puis te proposer un plan à approuver."}
              </p>
            </div>
          )}

          {messages.map((m, i) => {
            if (m.role === "assistant" && m.content === "" && sending && i === messages.length - 1) return null;
            const estDernier = i === messages.length - 1;
            const actions = m.role === "assistant" && estDernier && !sending ? (
              <>
                {estEdition && onAppliquer && (
                  <ActionsAppliquer content={m.content} onAppliquer={onAppliquer} appliqueAuto={appliqueAuto} />
                )}
                {!estEdition && (
                  <EncartsAgent
                    message={m}
                    onAnnuler={() => {
                      if (m.annulerEditions) appliquerChampsAdmin(onglet, [m.annulerEditions]);
                      annulerEditions(i);
                    }}
                    onApprouver={() => void approuver(i)}
                    onRejeter={() => rejeter(i)}
                    onIgnorer={(ai) => void ignorerAction(i, ai)}
                    onEditer={(ai, texte) => void editerAction(i, ai, texte)}
                  />
                )}
              </>
            ) : null;
            return (
              <ChatBubble
                key={`${m.role}-${i}`}
                m={m}
                userNom="Admin"
                actionsHaut={actions}
                estDernier={estDernier}
                enCours={sending}
                onEditer={m.role === "user" && !sending ? (contenu) => regenerateFrom(i, contenu) : undefined}
                onRegenerer={m.role === "assistant" && !sending && estDernier ? retryLast : undefined}
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
            <p role="status" className="rounded-lg border border-correction/30 bg-correction-soft px-3 py-2 text-sm text-correction">
              {erreurStream}
            </p>
          )}
        </div>

        {estEdition && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 border-t border-ink-soft/15 bg-paper px-4 text-xs">
            <label className="flex min-h-[44px] items-center gap-2">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => {
                  setAuto(e.target.checked);
                  memoriserApplicationAuto(e.target.checked);
                }}
              />
              Appliquer automatiquement
            </label>
            {onAnnuler && (
              <button
                type="button"
                onClick={() => {
                  onAnnuler();
                  setAppliqueAuto(false);
                }}
                className="min-h-[44px] font-medium text-correction underline underline-offset-2"
              >
                Annuler la dernière application
              </button>
            )}
          </div>
        )}

        <MessageComposer
          inputRef={inputRef}
          input={input}
          onChange={setInput}
          onKeyDown={onInputKeyDown}
          onSend={submitQuestion}
          queueCount={queue.length}
          disabled={enChargement}
          placeholder={
            estEdition
              ? "Pose ta question sur l'épreuve… (Maj+Entrée pour une nouvelle ligne)"
              : "Pose une question sur cet onglet… (Maj+Entrée pour une nouvelle ligne)"
          }
        />
      </div>
    </>
  );
}

/** Boutons « Appliquer » sous une réponse contenant des blocs `modification-*` : un clic
 * remplit le sujet, le corrigé ou les métadonnées du formulaire. */
function ActionsAppliquer({
  content,
  onAppliquer,
  appliqueAuto,
}: {
  content: string;
  onAppliquer: (m: ModificationsEpreuve) => boolean;
  appliqueAuto: boolean;
}) {
  const modifs = extraireModifications(content);
  const boutons: { cle: string; libelle: string; modifs: ModificationsEpreuve }[] = [
    ...(
      [
        ["sujet", "Appliquer au sujet"],
        ["corrige", "Appliquer au corrigé"],
        ["form", "Appliquer au formulaire"],
      ] as const
    )
      .filter(([cle]) => modifs[cle] !== undefined)
      .map(([cle, libelle]) => ({ cle, libelle, modifs: { [cle]: modifs[cle] } as ModificationsEpreuve })),
    ...(modifs.editions ?? []).map((ed, i) => {
      const cible = `${ed.cible === "sujet" ? "sujet" : "corrigé"}${ed.numero ? ` ${ed.numero}` : " affiché"}`;
      const n = ed.paires?.length ?? 0;
      return {
        cle: `edition-${i}`,
        libelle: ed.complet !== undefined ? `Réécrire le ${cible}` : `Appliquer ${n} modification${n > 1 ? "s" : ""} au ${cible}`,
        modifs: { editions: [ed] } as ModificationsEpreuve,
      };
    }),
  ];
  if (boutons.length === 0) return null;
  if (appliqueAuto) {
    return (
      <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-valide">
        <Check size={12} strokeWidth={2.5} aria-hidden="true" />
        Appliqué automatiquement au formulaire
      </p>
    );
  }
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {boutons.map((b) => (
        <button
          key={b.cle}
          type="button"
          onClick={() => onAppliquer(b.modifs)}
          className="min-h-[36px] rounded-full border border-highlight/50 bg-highlight-soft/50 px-3 text-[11px] font-medium text-highlight-text"
        >
          {b.libelle}
        </button>
      ))}
    </div>
  );
}

/** Encarts du mode agent : formulaire ouvert, champs remplis et plan signé. */
function EncartsAgent({
  message,
  onAnnuler,
  onApprouver,
  onRejeter,
  onIgnorer,
  onEditer,
}: {
  message: MessageAdmin;
  onAnnuler: () => void;
  onApprouver: () => void;
  onRejeter: () => void;
  onIgnorer: (ai: number) => void;
  onEditer: (ai: number, texte: string) => void;
}) {
  const plan = message.plan;
  return (
    <>
      {message.formulaires && message.formulaires.length > 0 && (
        <div className="mt-2 rounded-lg border border-highlight/50 bg-highlight-soft/40 p-3">
          <p className="font-medium">Formulaire ouvert : {message.formulaires.join(", ")}.</p>
          <p className="mt-1 text-xs text-ink-soft">Les champs sont prêts dans le panneau ; rien n'est enregistré.</p>
        </div>
      )}
      {message.editions && message.editions.length > 0 && (
        <div className="mt-2 rounded-lg border border-highlight/50 bg-highlight-soft/40 p-3">
          <p className="font-medium">Champs remplis dans le formulaire : {message.editions.join(", ")}.</p>
          <p className="mt-1 text-xs text-ink-soft">Rien n'est enregistré. Vérifie puis clique sur « Enregistrer » dans le panneau.</p>
          {message.annulerEditions && (
            <button
              type="button"
              onClick={onAnnuler}
              className="mt-2 min-h-[44px] rounded-full border border-ink-soft/30 px-4 text-xs"
            >
              Annuler ces modifications
            </button>
          )}
        </div>
      )}
      {plan && (
        <div className="mt-2 rounded-lg border border-highlight/50 bg-highlight-soft/40 p-3">
          <p className="font-medium">Plan d'actions — approbation groupée</p>
          <p className="mt-1 text-xs text-ink-soft">
            {plan.actions.length} action(s). Aucune écriture ne sera faite sans ton accord.
          </p>
          <ul className="mt-2 space-y-2">
            {plan.actions.map((a, ai) => (
              <PlanAction
                key={ai}
                action={a}
                desactivee={plan.etat !== "attente"}
                ignoree={(plan.ignorees ?? []).includes(ai)}
                onEdit={(texte) => onEditer(ai, texte)}
                onIgnore={() => onIgnorer(ai)}
              />
            ))}
          </ul>
          {plan.etat === "attente" && (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={onApprouver}
                className="flex min-h-[44px] items-center gap-1 rounded-full bg-ink px-4 text-paper"
              >
                <Check size={14} aria-hidden="true" /> Tout approuver
              </button>
              <button type="button" onClick={onRejeter} className="min-h-[44px] rounded-full border border-ink-soft/30 px-4">
                Rejeter
              </button>
            </div>
          )}
          {plan.etat === "en-cours" && (
            <p role="status" className="mt-2 text-xs">
              Exécution…
            </p>
          )}
          {plan.etat === "fait" && (
            <p role="status" className="mt-2 text-xs text-valide">
              ✓ Plan exécuté.
            </p>
          )}
          {plan.etat === "ignoree" && <p className="mt-2 text-xs text-slate">Plan rejeté — rien n'a été modifié.</p>}
          {plan.etat === "erreur" && (
            <p role="alert" className="mt-2 text-xs text-correction">
              Échec : {plan.erreur ?? "voir le détail"}
            </p>
          )}
        </div>
      )}
    </>
  );
}

function PlanAction({
  action,
  desactivee,
  ignoree,
  onEdit,
  onIgnore,
}: {
  action: ActionProposee;
  desactivee: boolean;
  ignoree: boolean;
  onEdit: (texte: string) => void;
  onIgnore: () => void;
}) {
  const [edition, setEdition] = useState(false);
  const [texte, setTexte] = useState(JSON.stringify(action, null, 2));
  return (
    <li className="rounded border border-ink-soft/20 p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-xs">{LIBELLES_OUTILS[action.outil] ?? action.outil}</p>
        {!desactivee && !ignoree && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setEdition((v) => !v)}
              aria-label="Éditer cette action"
              className="min-h-[44px] min-w-[44px] text-ink-soft"
            >
              <Pencil size={14} className="mx-auto" aria-hidden="true" />
            </button>
            <button type="button" onClick={onIgnore} className="min-h-[44px] rounded-full border border-ink-soft/30 px-3 text-xs">
              Ignorer
            </button>
          </div>
        )}
      </div>
      {ignoree && (
        <p role="status" className="mt-1 text-xs text-slate">
          Ignorée.
        </p>
      )}
      {edition ? (
        <div className="mt-1">
          <textarea
            value={texte}
            onChange={(e) => setTexte(e.target.value)}
            rows={5}
            aria-label="Arguments de l'action (JSON)"
            className="w-full rounded border border-ink-soft/30 bg-paper p-2 font-mono text-[11px]"
          />
          <button
            type="button"
            onClick={() => {
              onEdit(texte);
              setEdition(false);
            }}
            className="mt-1 min-h-[44px] rounded-full bg-ink px-4 text-xs text-paper"
          >
            Valider l'édition (nouveau jeton)
          </button>
        </div>
      ) : (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] text-ink-soft">
          {JSON.stringify(action.args, null, 2)}
        </pre>
      )}
    </li>
  );
}
