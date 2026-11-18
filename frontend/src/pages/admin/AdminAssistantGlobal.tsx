import { Bot, Check, Loader2, Pencil, Plus, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api, ApiError } from "../../api/client";
import { BoutonCopier } from "../../components/ChatParts";
import { MarkdownContent } from "../../components/MarkdownContent";
import { extraireActions, LIBELLES_OUTILS, type ActionProposee } from "../../lib/adminActions";
import { appliquerChampsAdmin, lireContexteAdmin, ouvrirFormulaireAdmin } from "../../lib/adminContexte";
import { chargerConversationAdmin, effacerConversationAdmin, streamAdminAsk } from "../../lib/streaming";
import { authHeaders } from "./shared";

type EtatAction = "attente" | "en-cours" | "fait" | "ignoree" | "erreur";
interface Plan {
  actions: ActionProposee[];
  jeton: string;
  etat: EtatAction;
  ignorees?: number[];
  erreur?: string;
}
interface Message {
  role: "user" | "assistant";
  content: string;
  plan?: Plan;
  formulaires?: string[];
  editions?: string[];
  annulerEditions?: Record<string, unknown>;
}

/**
 * Assistant du back-office pour TOUS les onglets (l'onglet Épreuves garde son
 * assistant d'édition). Il lit un résumé de l'onglet affiché, répond aux
 * questions et PEUT modifier le formulaire courant (brouillon, annulable).
 *
 * Les écritures serveur sont regroupées en UN plan signé côté serveur : rien
 * ne s'exécute sans l'approbation explicite de l'admin (« Tout approuver »).
 * Le jeton est lié aux actions exactes : éditer une action le rend invalide
 * et force une nouvelle signature via `/proposition`.
 */
export function AdminAssistantGlobal({ token, onglet, onAction }: { token: string; onglet: string; onAction: () => void }) {
  const [ouvert, setOuvert] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [saisie, setSaisie] = useState("");
  const [enCours, setEnCours] = useState(false);
  const [enChargement, setEnChargement] = useState(false);
  const fin = useRef<HTMLDivElement>(null);
  const cle = `onglet:${onglet}`;
  const session = useRef(0);
  const chargeePour = useRef<string | null>(null);

  useEffect(() => {
    if (!ouvert || chargeePour.current === cle) return;
    chargeePour.current = cle;
    const courante = ++session.current;
    setMessages([]);
    setEnCours(false);
    setEnChargement(true);
    void chargerConversationAdmin(cle).then((conversation) => {
      if (session.current !== courante) return;
      setMessages((conversation?.messages ?? []).map((m) => ({
        role: m.role,
        content: m.role === "user" ? m.content : extraireActions(m.content).texte || "(action proposée)",
      })));
      setEnChargement(false);
    });
  }, [ouvert, cle]);

  useEffect(() => {
    fin.current?.scrollIntoView?.({ block: "end" });
  }, [messages, ouvert]);

  const envoyer = async () => {
    const question = saisie.trim();
    if (!question || enCours || enChargement) return;
    const historique = messages.map((m) => ({ role: m.role, content: m.content }));
    const courante = session.current;
    const ecrire = (f: () => void) => session.current === courante && f();
    setSaisie("");
    setEnCours(true);
    setMessages((m) => [...m, { role: "user", content: question }, { role: "assistant", content: "" }]);

    let cumul = "";
    let erreur = "";
    let plan: Plan | null = null;
    const editionsRecues: Record<string, unknown>[] = [];
    const ciblesRecues: string[] = [];
    const avant: Record<string, unknown> = {};

    try {
      const contexte = lireContexteAdmin(onglet);
      await streamAdminAsk(
        { question, historique, epreuve: {}, onglet, agent: true, ...(contexte ? { contexte } : {}) },
        (e) => {
          if (e.type === "chunk") cumul += e.text;
          else if (e.type === "formulaire") ciblesRecues.push(e.cible);
          else if (e.type === "edition") editionsRecues.push(e.champs);
          else if (e.type === "proposition") {
            plan = { actions: e.actions, jeton: e.jeton, etat: "attente", ignorees: [] };
          } else if (e.type === "error") erreur = e.message;
        },
      );
    } catch (e) {
      erreur = e instanceof ApiError && e.status === 429 ? "Trop de demandes — réessaie dans quelques minutes." : "L'assistant n'a pas pu répondre.";
    }

    // L'agent peut demander l'ouverture d'un formulaire avant de le remplir.
    // flushSync garantit que le panneau a bien rendu le formulaire (et publié
    // son contexte) avant que les éditions ne soient appliquées.
    const formulairesOuverts: string[] = [];
    flushSync(() => {
      for (const cible of ciblesRecues) {
        if (ouvrirFormulaireAdmin(onglet, cible)) formulairesOuverts.push(cible);
      }
      // Le modèle peut envoyer les champs sans demander l'ouverture : on ouvre
      // alors le formulaire principal du panneau pour ne pas perdre l'édition.
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
      // Laisse React publier le contexte du formulaire fraîchement ouvert avant
      // de capturer l'état « avant » utilisé par le bouton Annuler.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const contexteAvant = lireContexteAdmin(onglet)?.formulaire as Record<string, unknown> | undefined;
      if (contexteAvant && typeof contexteAvant === "object") {
        for (const [cle, valeur] of Object.entries(contexteAvant)) {
          if (["string", "number", "boolean"].includes(typeof valeur)) avant[cle] = valeur;
        }
      }
    }
    const editionsAppliquees = editionsRecues.length > 0
      && appliquerChampsAdmin(onglet, editionsRecues);
    if (editionsRecues.length && !editionsAppliquees) {
      erreur = erreur || "Champs proposés, mais aucun formulaire n'est ouvert dans ce panneau.";
    }
    // Compatibilité : une réponse « historique » peut encore contenir des
    // blocs ```action``` ; on les regroupe alors en plan avec un jeton neuf.
    const actionsTexte = extraireActions(cumul).actions;
    if (!plan && actionsTexte.length) {
      try {
        const reponse = await api.post<{ jeton: string }>("/api/admin/assistant/proposition", actionsTexte, authHeaders(token));
        plan = { actions: actionsTexte, jeton: reponse.jeton, etat: "attente", ignorees: [] };
      } catch {
        // On affiche quand même le plan : l'admin doit voir (et pouvoir rejeter)
        // une action que le modèle a proposée, même si sa signature a échoué.
        plan = { actions: actionsTexte, jeton: "", etat: "attente", ignorees: [] };
      }
    }
    const nomsEditions = editionsRecues.flatMap((champs) => Object.keys(champs));
    const texteAffiche = extraireActions(cumul).texte;

    ecrire(() => {
      setMessages((m) => [
        ...m.slice(0, -1),
        {
          role: "assistant",
          content: erreur ? `⚠️ ${erreur}` : texteAffiche || (plan ? "(plan d'actions proposé)" : nomsEditions.length ? "(champs du formulaire remplis)" : "(réponse vide)"),
          plan: plan ?? undefined,
          formulaires: formulairesOuverts.length ? formulairesOuverts : undefined,
          editions: nomsEditions.length ? nomsEditions : undefined,
          annulerEditions: nomsEditions.length ? avant : undefined,
        },
      ]);
      setEnCours(false);
    });
  };

  const nouvelleConversation = () => {
    if (enCours) return;
    setMessages([]);
    void effacerConversationAdmin(cle);
  };

  const majPlan = (mi: number, changements: Partial<Plan>) =>
    setMessages((ms) => ms.map((m, i) => (i !== mi || !m.plan ? m : { ...m, plan: { ...m.plan, ...changements } })));

  const annulerEditions = (mi: number) => {
    setMessages((ms) => ms.map((m, i) => (i !== mi ? m : { ...m, editions: undefined, annulerEditions: undefined })));
  };

  const approuver = async (mi: number) => {
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
        authHeaders(token),
      );
      const echecs = r.resultats.filter((x) => !x.ok);
      majPlan(mi, { etat: echecs.length ? "erreur" : "fait", erreur: echecs.map((x) => x.erreur).join(" ; ") });
      onAction();
    } catch (e) {
      const detail = e instanceof ApiError ? (typeof e.detail === "string" ? e.detail : "refusé") : "échec réseau";
      majPlan(mi, { etat: "erreur", erreur: detail });
    }
  };

  const rejeter = (mi: number) => majPlan(mi, { etat: "ignoree" });

  /** Ignore une action du plan : elle reste affichée (« Ignorée. ») mais est
   *  retirée du lot exécuté, et le jeton est renouvelé pour les actions restantes. */
  const ignorerAction = async (mi: number, ai: number) => {
    const plan = messages[mi]?.plan;
    if (!plan) return;
    const ignorees = [...new Set([...(plan.ignorees ?? []), ai])];
    const actions = plan.actions.filter((_, i) => !ignorees.includes(i));
    let jeton = plan.jeton;
    if (actions.length) {
      try {
        jeton = (await api.post<{ jeton: string }>("/api/admin/assistant/proposition", actions, authHeaders(token))).jeton;
      } catch {
        jeton = "";
      }
    }
    majPlan(mi, { ignorees, jeton });
  };

  const editerAction = async (mi: number, ai: number, texte: string) => {
    const plan = messages[mi]?.plan;
    if (!plan) return;
    try {
      const objet = JSON.parse(texte) as { outil?: string; args?: Record<string, unknown> };
      if (typeof objet.outil !== "string" || !objet.args) throw new Error("Format : {\"outil\": \"…\", \"args\": {…}}");
      const actions = plan.actions.map((a, i) => (i === ai ? { outil: objet.outil!, args: objet.args! } : a));
      const reponse = await api.post<{ jeton: string }>("/api/admin/assistant/proposition", actions, authHeaders(token));
      majPlan(mi, { actions, jeton: reponse.jeton, etat: "attente" });
    } catch (e) {
      majPlan(mi, { etat: "erreur", erreur: e instanceof Error ? e.message : "JSON invalide" });
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
        <div className="flex items-center gap-1">
          <button
            onClick={nouvelleConversation}
            disabled={messages.length === 0 || enCours}
            title="Nouvelle conversation (efface l'échange de cet onglet)"
            className="flex min-h-[44px] items-center gap-1 rounded-full border border-ink-soft/25 px-3 font-mono-tag text-[10px] text-ink-soft disabled:opacity-40"
          >
            <Plus size={12} aria-hidden="true" /> Nouvelle conversation
          </button>
          <button onClick={() => setOuvert(false)} aria-label="Fermer l'assistant" className="min-h-[44px] min-w-[44px]">
            <X size={18} className="mx-auto" />
          </button>
        </div>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" role="log">
        {enChargement && <p className="text-sm text-slate">Chargement de la discussion…</p>}
        {messages.length === 0 && !enChargement && (
          <p className="text-sm text-ink-soft">Pose une question sur cet onglet : l'agent peut remplir le formulaire, puis te proposer un plan à approuver.</p>
        )}
        {messages.map((m, mi) => (
          <div key={mi} className={m.role === "user" ? "ml-8 rounded-lg bg-ink px-3 py-2 text-sm text-paper" : "mr-4 text-sm"}>
            {m.role === "user" ? m.content : m.content ? <MarkdownContent content={m.content} variant="chat" /> : <Loader2 size={14} className="animate-spin" aria-label="L'assistant réfléchit" />}
            {m.content.trim() && !m.content.startsWith("⚠️") && (
              <div className="mt-0.5"><BoutonCopier texte={m.content} /></div>
            )}
            {m.formulaires && m.formulaires.length > 0 && (
              <div className="mt-2 rounded-lg border border-highlight/50 bg-highlight-soft/40 p-3">
                <p className="font-medium">Formulaire ouvert : {m.formulaires.join(", ")}.</p>
                <p className="mt-1 text-xs text-ink-soft">Les champs sont prêts dans le panneau ; rien n'est enregistré.</p>
              </div>
            )}
            {m.editions && m.editions.length > 0 && (
              <div className="mt-2 rounded-lg border border-highlight/50 bg-highlight-soft/40 p-3">
                <p className="font-medium">Champs remplis dans le formulaire : {m.editions.join(", ")}.</p>
                <p className="mt-1 text-xs text-ink-soft">Rien n'est enregistré. Vérifie puis clique sur « Enregistrer » dans le panneau.</p>
                {m.annulerEditions && (
                  <button onClick={() => { if (m.annulerEditions) appliquerChampsAdmin(onglet, [m.annulerEditions]); annulerEditions(mi); }} className="mt-2 min-h-[44px] rounded-full border border-ink-soft/30 px-4 text-xs">
                    Annuler ces modifications
                  </button>
                )}
              </div>
            )}
            {m.plan && (
              <div className="mt-2 rounded-lg border border-highlight/50 bg-highlight-soft/40 p-3">
                <p className="font-medium">Plan d'actions — approbation groupée</p>
                <p className="mt-1 text-xs text-ink-soft">
                  {m.plan.actions.length} action(s). Aucune écriture ne sera faite sans ton accord.
                </p>
                <ul className="mt-2 space-y-2">
                  {m.plan.actions.map((a, ai) => (
                    <PlanAction
                      key={ai}
                      action={a}
                      desactivee={m.plan!.etat !== "attente"}
                      ignoree={(m.plan!.ignorees ?? []).includes(ai)}
                      onEdit={(texte) => void editerAction(mi, ai, texte)}
                      onIgnore={() => void ignorerAction(mi, ai)}
                    />
                  ))}
                </ul>
                {m.plan.etat === "attente" && (
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => void approuver(mi)} className="flex min-h-[44px] items-center gap-1 rounded-full bg-ink px-4 text-paper">
                      <Check size={14} aria-hidden="true" /> Tout approuver
                    </button>
                    <button onClick={() => rejeter(mi)} className="min-h-[44px] rounded-full border border-ink-soft/30 px-4">Rejeter</button>
                  </div>
                )}
                {m.plan.etat === "en-cours" && <p role="status" className="mt-2 text-xs">Exécution…</p>}
                {m.plan.etat === "fait" && <p role="status" className="mt-2 text-xs text-valide">✓ Plan exécuté.</p>}
                {m.plan.etat === "ignoree" && <p className="mt-2 text-xs text-slate">Plan rejeté — rien n'a été modifié.</p>}
                {m.plan.etat === "erreur" && <p role="alert" className="mt-2 text-xs text-correction">Échec : {m.plan.erreur ?? "voir le détail"}</p>}
              </div>
            )}
          </div>
        ))}
        <div ref={fin} />
      </div>
      <form
        className="flex items-end gap-2 border-t border-ink-soft/15 p-3"
        onSubmit={(e) => { e.preventDefault(); void envoyer(); }}
      >
        <textarea
          value={saisie}
          onChange={(e) => setSaisie(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void envoyer(); } }}
          rows={2}
          aria-label="Question à l'assistant"
          placeholder="Ex. Crée une formule trimestrielle et corrige le prix de la mensuelle…"
          className="min-h-[44px] flex-1 resize-none rounded border border-ink-soft/30 bg-paper px-2 py-1.5 text-sm"
        />
        <button type="submit" disabled={enCours || enChargement || !saisie.trim()} aria-label="Envoyer" className="min-h-[44px] min-w-[44px] rounded-full bg-ink text-paper disabled:opacity-50">
          <Send size={16} className="mx-auto" />
        </button>
      </form>
    </aside>
  );
}

function PlanAction({ action, desactivee, ignoree, onEdit, onIgnore }: {
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
            <button onClick={() => setEdition((v) => !v)} aria-label="Éditer cette action" className="min-h-[44px] min-w-[44px] text-ink-soft">
              <Pencil size={14} className="mx-auto" />
            </button>
            <button onClick={onIgnore} className="min-h-[44px] rounded-full border border-ink-soft/30 px-3 text-xs">
              Ignorer
            </button>
          </div>
        )}
      </div>
      {ignoree && <p role="status" className="mt-1 text-xs text-slate">Ignorée.</p>}
      {edition ? (
        <div className="mt-1">
          <textarea
            value={texte}
            onChange={(e) => setTexte(e.target.value)}
            rows={5}
            aria-label="Arguments de l'action (JSON)"
            className="w-full rounded border border-ink-soft/30 bg-paper p-2 font-mono text-[11px]"
          />
          <button onClick={() => { onEdit(texte); setEdition(false); }} className="mt-1 min-h-[44px] rounded-full bg-ink px-4 text-xs text-paper">
            Valider l'édition (nouveau jeton)
          </button>
        </div>
      ) : (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] text-ink-soft">{JSON.stringify(action.args, null, 2)}</pre>
      )}
    </li>
  );
}
