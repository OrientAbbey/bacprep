import { Bot, Check, ChevronDown, ChevronRight, Clock, Pencil, Plus, RotateCcw, Send, StickyNote, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { dateLongue, heureCourte } from "../lib/dates";
import { getInitials } from "../lib/initials";
import { delaiReconnexion, streamAssistantAsk, type AssistantAskPayload } from "../lib/streaming";
import { MarkdownContent } from "./MarkdownContent";
import { useToast } from "./Toast";

/** Nom du produit assistant (en-tête du panneau, bouton lanceur) et
 * signature affichée sur chacune de ses réponses. */
export const ASSISTANT_TITRE = "Tuteur IA Prep";
export const ASSISTANT_SIGNATURE = "Assistant Pédagogique";

export interface Message {
  role: "user" | "assistant";
  content: string;
  /** Horodatage ISO de création, posé par le serveur (voie persistée) ou
   * par le client (éphémère) — affiché en HH:MM à côté de la bulle. Les
   * messages stockés AVANT ce changement n'en portent pas (aucun
   * affichage d'heure pour eux). */
  ts?: string;
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
// Longueur max du libellé d'un onglet auto-renommé à partir de la première
// question de l'élève (au-delà, tronqué avec une ellipse).
const LABEL_MAX_LEN = 24;

/**
 * Panneau de l'assistant. Suit le thème clair/sombre de la page et
 * n'assume plus sa propre position à l'écran : l'appelant (ViewerPage)
 * le place SOIT en tiroir latéral droit (bureau, colonne sœur du lecteur
 * — jamais par-dessus l'épreuve), SOIT en feuille modale plein écran
 * (mobile). Ce sont les DEUX SEULS modes.
 *
 * MODE ÉPHÉMÈRE : si l'élève a refusé le stockage de ses conversations IA
 * (`user.consent_ia === false`), AUCUNE discussion n'est envoyée à l'API —
 * les onglets vivent uniquement dans l'état du panneau (perdus à la
 * fermeture), et les questions partent en `epreuve_id`/`historique` sans
 * `conversation_id` (le serveur ne persiste rien non plus).
 */
/** Extrait le message explicite d'un HTTPException FastAPI (corps
 * `{"detail": "..."}`), qu'il vienne de `ApiError.detail` (client.ts) ou de
 * l'erreur enrichie par `streamEventSource` (streaming.ts). Retourne `null`
 * si le corps ne porte pas de chaîne exploitable (ex. validation 422). */
function detailServeur(err: unknown): string | null {
  const brut = (err as { detail?: unknown })?.detail;
  const detail =
    typeof brut === "string"
      ? brut
      : brut && typeof brut === "object"
        ? (brut as { detail?: unknown }).detail
        : undefined;
  return typeof detail === "string" && detail.trim() ? detail : null;
}

/** Libellé d'onglet lisible dérivé d'un texte (première question du élève
 * ou passage sélectionné) : nettoyé, tronqué avec ellipse. */
function resumeLabel(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > LABEL_MAX_LEN ? clean.slice(0, LABEL_MAX_LEN).trimEnd() + "…" : clean;
}

/** Libellés par défaut à ne PAS conserver comme titre une fois que
 * l'élève a posé sa première question (l'onglet prend alors le titre de
 * la question, bien plus reconnaissable que "Discussion générale"). */
function isDefaultLabel(label: string): boolean {
  return (
    label === "Discussion générale" ||
    label === "Épreuve entière" ||
    label === "Passage sélectionné" ||
    label.startsWith("Passage : ")
  );
}

/** Dédoublonne un libellé d'onglet (« Discussion générale » pris →
 * « Discussion générale 2 »…) — convention des messageries pour éviter
 * plusieurs onglets rigoureusement identiques. */
function labelUnique(base: string, existantes: { label: string }[]): string {
  const pris = new Set(existantes.map((c) => c.label));
  if (!pris.has(base)) return base;
  let n = 2;
  while (pris.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

export function AssistantPanel({
  epreuveId,
  pendingContext,
  fullEpreuveContext,
  pasteSignal,
  ouvrirConversationId,
  onClose,
  onSaveAsNote,
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
  /** Deep-link depuis l'historique d'activité du profil
   * (/epreuve/{id}?conv={id}) : rouvre CETTE discussion au montage. */
  ouvrirConversationId?: string | null;
  onClose: () => void;
  /** Ouvre l'éditeur de note prérempli avec cette réponse d'assistant
   * (bouton « Sauvegarder en note » sous chaque bulle de l'assistant). */
  onSaveAsNote?: (contenu: string, contexte: string) => void;
  mobile: boolean;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [erreurChargement, setErreurChargement] = useState(false);
  // Bloc contexte repliable : REPLIÉ par défaut pour laisser le maximum de
  // place au fil de discussion (le contexte complet reste transmis à
  // l'assistant quoi qu'il arrive — ce n'est qu'un choix d'affichage).
  const [contextOpen, setContextOpen] = useState(false);
  // Erreur de streaming affichée EN DEHORS du fil (jamais injectée en
  // italique dans la dernière bulle, où elle était indiscernable d'une
  // vraie réponse de l'assistant).
  const [erreurStream, setErreurStream] = useState<string | null>(null);
  // Messages en file d'attente : envoyés automatiquement dès que la
  // réponse en cours est terminée (voir l'effet de dépilement).
  const [queue, setQueue] = useState<string[]>([]);
  // Tentative de reconnexion automatique en cours (SSE) : 0 = aucune.
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { user } = useAuth();
  const { showToast } = useToast();
  const userNom = user?.nom?.trim() || "Toi";
  // Refus du stockage IA → tout vit en mémoire locale, jamais en base.
  const ephemere = user?.consent_ia === false;

  const active = conversations.find((c) => c.id === activeId) || null;

  // Ref miroir de `conversations` : les closures créées par send() (handler
  // SSE du streaming) liraient sinon une liste FIGÉE au moment de l'envoi —
  // fausse le dédoublonnage du label d'onglet en fin de flux.
  const conversationsRef = useRef<Conversation[]>([]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // Ref miroir de l'onglet actif : les fonctions de l'envoi (y compris le
  // dépilement automatique de la file d'attente) doivent lire l'état le
  // PLUS RÉCENT, jamais une closure figée au moment où elles ont été créées.
  const activeRef = useRef<Conversation | null>(null);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Fermeture de l'onglet actif : au rendu suivant, activeId n'est plus dans
  // la liste — on retombe sur le dernier onglet (ou aucun). Décision de
  // synchronisation pure, SANS setActiveId dans un updater (les updaters
  // doivent rester sans effet de bord ; StrictMode les relance deux fois).
  useEffect(() => {
    if (activeId && !conversations.some((c) => c.id === activeId)) {
      setActiveId(conversations.length ? conversations[conversations.length - 1].id : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, conversations]);

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
      setErreurChargement(false);
      try {
        if (ephemere) {
          // Aucun aller-retour API : une discussion locale, vide.
          setConversations([
            {
              id: "ephemere",
              epreuve_id: epreuveId,
              label: pendingContext ? "Passage : " + resumeLabel(pendingContext) : "Discussion éphémère",
              contexte: pendingContext ?? fullEpreuveContext,
              messages: [],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ]);
          setActiveId("ephemere");
          return;
        }

        const convs = await api.get<Conversation[]>(`/api/epreuves/${epreuveId}/conversations`);
        setConversations(convs);

        if (ouvrirConversationId && convs.some((c) => c.id === ouvrirConversationId)) {
          // Deep-link : on ouvre la discussion demandée (jamais une nouvelle
          // à la place — l'élève vient expressément pour celle-ci).
          setActiveId(ouvrirConversationId);
        } else if (pendingContext) {
          await createConversation(pendingContext, labelUnique("Passage : " + resumeLabel(pendingContext), convs));
        } else if (convs.length > 0) {
          setActiveId(convs[convs.length - 1].id);
        } else {
          // Aucune sélection préalable : le contexte par défaut est
          // l'épreuve entière (onglet actif), jamais une chaîne vide.
          await createConversation(fullEpreuveContext, labelUnique("Discussion générale", convs));
        }
      } catch {
        // Avant : try/finally sans catch — un échec réseau laissait le
        // panneau en « Chargement… » avec un rejet non géré.
        setErreurChargement(true);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epreuveId]);

  // Focus du champ de saisie dès que le panneau est prêt (init terminée,
  // discussion éphémère y compris) — la frappe immédiate doit répondre
  // sans clic supplémentaire.
  useEffect(() => {
    if (loading) return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [loading]);

  // Échap ferme le panneau lui-même — en feuille mobile comme en tiroir
  // bureau (le tiroir desktop, colonne sœur du lecteur, se ferme sur la
  // même touche).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.messages.length, active?.messages.reduce((acc, m) => acc + m.content.length, 0)]);

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
    if (conversations.length >= MAX_CONVERSATIONS) {
      showToast("Limite de discussions atteinte pour cette épreuve (5).", "error");
      return;
    }
    if (ephemere) {
      const local: Conversation = {
        id: `ephemere-${conversations.length + 1}`,
        epreuve_id: epreuveId,
        label: labelUnique(label, conversations),
        contexte,
        messages: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setConversations((prev) => [...prev, local]);
      setActiveId(local.id);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    try {
      const conv = await api.post<Conversation>(`/api/epreuves/${epreuveId}/conversations`, {
        contexte,
        label,
      });
      setConversations((prev) => [...prev, conv]);
      setActiveId(conv.id);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        // Refus de consentement enregistré pendant la session : bascule
        // silencieuse en éphémère au prochain rendu (l'utilisateur voit un
        // toast explicite).
        showToast("Stockage des discussions refusé — mode éphémère (rien n'est enregistré).", "info");
        return;
      }
      if (err instanceof ApiError && err.status === 409) return;
      showToast("La discussion n'a pas pu être créée — réessaie.", "error");
    }
  }

  function closeConversation(id: string) {
    // La bascule d'onglet (si on ferme l'actif) est gérée par l'effet de
    // synchronisation ci-dessus — pas d'effet de bord dans les updaters.
    if (ephemere) {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      return;
    }
    (async () => {
      try {
        await api.del(`/api/epreuves/${epreuveId}/conversations/${id}`);
      } catch {
        showToast("La discussion n'a pas pu être fermée — réessaie.", "error");
        return;
      }
      setConversations((prev) => prev.filter((c) => c.id !== id));
    })();
  }

  /** Envoie la question courante à l'assistant en streaming (activé par
   * défaut). Voir lib/streaming.ts pour le détail du protocole SSE. En
   * mode éphémère, la charge utile embarque epreuve_id/contexte/historique
   * et le serveur ne persiste RIEN (`done.conversation` vaut null). */
  /** Soumission depuis le champ de saisie (bouton ou Entrée) : si une
   * réponse est déjà en cours, la question part en FILE D'ATTENTE plutôt
   * que d'être ignorée — elle sera envoyée automatiquement dès que la
   * réponse en cours se termine (succès ou échec définitif). */
  function submitQuestion() {
    const text = input.trim();
    if (!text) return;
    if (sending) {
      setQueue((q) => [...q, text]);
      setInput("");
      return;
    }
    const conv = activeRef.current;
    if (!conv) return;
    setInput("");
    void applyExchange(conv.id, text, conv.messages);
  }

  // Dépilement automatique de la file d'attente : dès que l'échange en
  // cours se termine (`sending` repasse à false), la première question
  // mise en attente est envoyée par la même voie.
  useEffect(() => {
    if (sending || queue.length === 0) return;
    const [prochaine, ...restantes] = queue;
    setQueue(restantes);
    const conv = activeRef.current;
    if (!conv) return;
    void applyExchange(conv.id, prochaine, conv.messages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending, queue]);

  /**
   * Exécute UN échange complet (question → réponse streamée) sur la
   * conversation `convId`. `base` = l'état des messages AVANT la question :
   * c'est à la fois l'état local de départ (on y ajoute la question + la
   * bulle assistant vide) et l'état de persistance attendu côté serveur.
   *
   * RECONNEXION AUTOMATIQUE : si le flux s'interrompt SANS `done` (panne
   * réseau, fermeture serveur) — et seulement dans ce cas — la charge utile
   * est renvoyée telle quelle (identique) après un délai croissant, jusqu'à
   * MAX_ATTEMPTES tentatives. Les erreurs applicatives du flux (évènement
   * `error`) et les 4xx ne sont PAS relancées automatiquement.
   *
   * Voie persistée : avant CHAQUE tentative, les messages serveur sont
   * ramenés à `base` (une tentative interrompue laisse un message
   * utilisateur résiduel écrit à la volée — une réémission l'aurait sinon
   * dupliqué). C'est aussi ce qui rend l'édition/régénération et le
   * réessai corrects : la troncature locale est reproduite côté serveur.
   */
  async function applyExchange(convId: string, question: string, base: Message[]) {
    const conversation = conversationsRef.current.find((c) => c.id === convId);
    if (!conversation) return;
    const url = `/api/epreuves/${epreuveId}/conversations/${convId}`;
    const nowIso = new Date().toISOString();

    // Ajout optimiste : la question + une bulle assistant vide (remplie au
    // fil du streaming).
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? {
              ...c,
              messages: [
                ...base,
                { role: "user", content: question, ts: nowIso },
                { role: "assistant", content: "", ts: nowIso },
              ],
            }
          : c
      )
    );
    setSending(true);
    setErreurStream(null);

    // Charge utile FIGÉE à la première tentative : chaque reconnexion
    // renvoie exactement la même question (jamais l'état local du moment,
    // qui contiendrait déjà la question optimiste et la dupliquerait).
    const payload: AssistantAskPayload = ephemere
      ? {
          epreuve_id: epreuveId,
          contexte: conversation.contexte,
          historique: base,
          message: question,
        }
      : { conversation_id: convId, message: question };

    const MAX_ATTEMPTES = 3;
    let erreurFinale: string | null = null;
    let aReussi = false;

    for (let tentative = 1; tentative <= MAX_ATTEMPTES; tentative++) {
      let gotDone = false;
      let gotErrorEvent = false;
      let pendingChunkText = "";
      let chunkRaf: number | null = null;

      // Fragments SSE tamponnés : appliqués une fois par frame (rAF) au
      // lieu de re-rendre à CHAQUE paquet réseau — le panneau reste fluide
      // pendant qu'un long texte défile. `flushChunk` est aussi forcé
      // avant toute réconciliation serveur (événement `done`).
      function flushChunk() {
        chunkRaf = null;
        if (!pendingChunkText) return;
        const fragment = pendingChunkText;
        pendingChunkText = "";
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

      if (tentative > 1) {
        // Nouvelle tentative : toute réponse partielle est remise à zéro.
        setConversations((prev) =>
          prev.map((c) =>
            c.id !== convId
              ? c
              : {
                  ...c,
                  messages: [
                    ...c.messages.slice(0, -1),
                    { role: "assistant", content: "", ts: new Date().toISOString() },
                  ],
                }
          )
        );
        setReconnectAttempt(tentative);
      }

      if (!ephemere) {
        // Réconciliation : ramène les messages serveur à `base` (le résidu
        // éventuel d'une tentative interrompue ne doit pas être dupliqué).
        // Une panne transitoire ICI ne doit PAS enterrer la boucle de
        // reconnexion (le panneau admin, qui ne réconcilie pas, surmonte
        // les mêmes pannes grâce au retry) — seul un 4xx est définitif.
        try {
          const actuels = await api.get<Conversation>(url);
          if (JSON.stringify(actuels.messages) !== JSON.stringify(base)) {
            await api.put<Conversation>(url, { messages: base });
          }
        } catch (err) {
          const status = (err as Error & { status?: number })?.status;
          if (typeof status === "number" && status >= 400 && status < 500) {
            // Erreur client (ex. 404 : discussion supprimée ailleurs,
            // 401 : session expirée, 403 : épreuve retirée / paywall) :
            // définitif, pas de relance aveugle. La raison explicite du
            // serveur (corps `detail`) prime sur un message générique.
            erreurFinale =
              status === 404
                ? "Cette discussion n'existe plus (elle a peut-être été fermée)."
                : (detailServeur(err) ??
                  (err instanceof Error ? err.message : "Requête refusée."));
            break;
          }
          // Transitoire (réseau, 5xx) : on le note mais on laisse la
          // boucle de reconnexion tenter à nouveau avant d'abandonner.
          erreurFinale =
            err instanceof TypeError
              ? "Connexion au serveur interrompue."
              : err instanceof Error
                ? err.message
                : "Impossible de synchroniser la discussion.";
        }
      }

      try {
        await streamAssistantAsk(payload, (event) => {
          if (event.type === "chunk") {
            pendingChunkText += event.text;
            if (chunkRaf === null) chunkRaf = requestAnimationFrame(flushChunk);
          } else if (event.type === "done") {
            gotDone = true;
            // Vider le tampon de chunks restants AVANT toute réconciliation,
            // sinon le rAF en attente écraserait l'état serveur reçu.
            if (chunkRaf !== null) cancelAnimationFrame(chunkRaf);
            flushChunk();
            if (!event.conversation) return; // voie éphémère : rien à réconcilier
            const conversation = event.conversation;
            setConversations((prev) => prev.map((c) => (c.id === conversation.id ? conversation : c)));
            // Premier échange : l'onglet prend le titre de la question de
            // l'élève (bien plus reconnaissable qu'un libellé générique),
            // dédoublonné contre les onglets restants — lu depuis la ref
            // miroir, jamais depuis la closure figée de l'envoi.
            if (isDefaultLabel(conversation.label)) {
              const nouveau = labelUnique(
                resumeLabel(question),
                conversationsRef.current.filter((c) => c.id !== convId)
              );
              void (async () => {
                try {
                  const updated = await api.put<Conversation>(url, {
                    messages: conversation.messages,
                    label: nouveau,
                  });
                  setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
                } catch {
                  /* renommage cosmétique : silencieux si l'aller-retour échoue */
                }
              })();
            }
          } else if (event.type === "error") {
            gotErrorEvent = true;
            erreurFinale = event.message;
          }
        });
      } catch (err) {
        const status = (err as Error & { status?: number })?.status;
        if (typeof status === "number" && status >= 400 && status < 500) {
          // Erreur client (ex. 403 : épreuve retirée entre-temps, paywall,
          // consentement refusé) : pas de relance aveugle. Le `detail` du
          // serveur porte la VRAIE raison — on l'affiche telle quelle.
          erreurFinale =
            detailServeur(err) ??
            (err instanceof Error ? err.message : "Requête refusée.");
          break;
        }
        // Panne transport ou 5xx transitoire : boucle de reconnexion.
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

  /** Réessaye la DERNIÈRE réponse : retire le dernier échange
   * (question + réponse assistant) puis renvoie exactement la même
   * question — réutilise la reconnexion/la persistance d'`applyExchange`. */
  function retryLast() {
    if (sending) return;
    const conv = activeRef.current;
    if (!conv) return;
    const msgs = conv.messages;
    const dernier = msgs[msgs.length - 1];
    if (!dernier || dernier.role !== "assistant") return;
    const question = msgs[msgs.length - 2];
    if (!question || question.role !== "user") return;
    void applyExchange(conv.id, question.content, msgs.slice(0, -2));
  }

  /** Édition d'un message de l'élève + régénération À PARTIR DE CE POINT :
   * la conversation est tronquée juste avant le message édité, qui est
   * renvoyé tel quel (c'est la nouvelle question) — tout ce qui suivait
   * (réponses, questions suivantes) est abandonné. */
  function regenerateFrom(index: number, contenu: string) {
    if (sending) return;
    const conv = activeRef.current;
    if (!conv) return;
    const msgs = conv.messages;
    if (!msgs[index] || msgs[index].role !== "user") return;
    void applyExchange(conv.id, contenu, msgs.slice(0, index));
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Entrée seule envoie (ou met en file d'attente si une réponse est en
    // cours) ; Maj+Entrée insère un saut de ligne, nécessaire maintenant
    // que le champ est multi-ligne.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitQuestion();
    }
  }

  const contexteEstLong = (active?.contexte?.length ?? 0) > CONTEXTE_PREVIEW_THRESHOLD;
  // Aperçu une-ligne du contexte quand le bloc est replié.
  const aperçuContexte = (active?.contexte ?? "").replace(/\s+/g, " ").slice(0, CONTEXTE_PREVIEW_LENGTH);

  const containerClass = mobile
    ? "fixed inset-0 z-50 flex flex-col bg-paper-raised text-ink"
    : "flex h-full w-full flex-col bg-paper-raised text-ink";

  return (
    <>
      <div
        className={containerClass}
        aria-label={ASSISTANT_TITRE}
      >
        {/* En-tête en deux rangées : titre du produit (Tuteur IA Prep) avec
            les actions à droite, puis la barre d'onglets de discussion.
            La grille `minmax(0,1fr)` de la rangée d'onglets garantit que
            celle-ci peut rétrécir et défiler en interne (bug corrigé par le
            passé : des onglets restaient inaccessibles derrière le bouton +). */}
        <div className="border-b border-ink-soft/15 bg-paper">
          <div className="flex items-center justify-between gap-2 px-3 pt-2">
            <div className="min-w-0">
              <h2 className="font-serif-brand text-sm leading-tight">{ASSISTANT_TITRE}</h2>
              <p className="font-mono-tag text-[10px] text-slate">
                {ephemere ? `${ASSISTANT_SIGNATURE} · éphémère (non enregistré)` : ASSISTANT_SIGNATURE}
              </p>
            </div>
            <div className="flex shrink-0 items-center">
              <button
                type="button"
                disabled={conversations.length >= MAX_CONVERSATIONS}
                onClick={() => createConversation(fullEpreuveContext, labelUnique("Discussion générale", conversations))}
                title="Nouvelle discussion"
                aria-label="Nouvelle discussion"
                className="relative flex h-8 w-8 items-center justify-center rounded-full border border-ink-soft/25 text-ink-soft after:absolute after:-inset-1.5 after:rounded-full after:content-[''] disabled:opacity-40"
              >
                <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
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
          {conversations.length > 0 && (
            <ConversationTabs
              conversations={conversations}
              activeId={activeId}
              onOpen={setActiveId}
              onClose={closeConversation}
            />
          )}
        </div>

        <div
          ref={scrollRef}
          role="log"
          aria-label={`Discussion avec ${ASSISTANT_TITRE}`}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4"
        >
          {loading && <p className="text-sm text-slate">Chargement…</p>}
          {erreurChargement && !loading && (
            <p className="rounded-lg border border-correction/30 bg-correction-soft p-3 text-sm text-correction">
              Les discussions n'ont pas pu être chargées — ferme et rouvre le panneau.
            </p>
          )}

          {active?.contexte && (
            <div className="rounded-lg border-l-4 border-highlight bg-highlight-soft/40 px-3 py-2">
              <button
                type="button"
                onClick={() => setContextOpen((o) => !o)}
                aria-expanded={contextOpen}
                className="flex min-h-[44px] w-full items-center gap-1 text-left font-mono-tag text-[10px] text-ink-soft"
              >
                {contextOpen ? (
                  <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
                ) : (
                  <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
                )}
                {contexteEstLong ? "Contexte (épreuve entière)" : "Passage sélectionné"}
              </button>
              {/* Replié : une seule ligne d'aperçu, pour laisser le maximum
                  de place à la discussion ; déplié : contenu complet. */}
              {contextOpen ? (
                <div className="mt-1 text-ink">
                  <MarkdownContent content={active.contexte} variant="chat" />
                </div>
              ) : (
                <p className="mt-0.5 line-clamp-1 text-xs text-ink-soft">{aperçuContexte}</p>
              )}
            </div>
          )}

          {active && active.messages.length === 0 && (
            <div className="pt-6 text-center">
              <Bot size={28} strokeWidth={1.5} aria-hidden="true" className="mx-auto text-slate" />
              <p className="mt-2 text-sm font-medium">Pose ta première question</p>
              <p className="mt-1 text-xs text-slate">
                Demande une explication, une méthode, ou la correction d'un exercice de cette épreuve.
              </p>
            </div>
          )}

          {active &&
            active.messages.map((m, i) => {
              // Pendant l'envoi, la bulle assistant est pré-créée VIDE : on
              // la masque pour ne pas afficher une boîte vide en parallèle
              // de l'indicateur « Assistant Pédagogique réfléchit… ».
              if (m.role === "assistant" && m.content === "" && sending) return null;
              const estDernier = i === active.messages.length - 1;
              return (
                <ChatBubble
                  key={`${m.role}-${i}`}
                  m={m}
                  questionContexte={i > 0 ? active.messages[i - 1]?.content ?? "" : ""}
                  userNom={userNom}
                  onSaveAsNote={onSaveAsNote}
                  peutSauvegarder={user?.consent_notes !== false}
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
            active &&
            active.messages[active.messages.length - 1]?.role === "assistant" &&
            active.messages[active.messages.length - 1]?.content === "" && (
              <div className="flex items-end gap-2">
                <Avatar role="assistant" nom={ASSISTANT_SIGNATURE} />
                <p className="text-sm text-slate">
                  {reconnectAttempt > 0
                    ? `Connexion instable — reconnexion (${reconnectAttempt}/3)…`
                    : `${ASSISTANT_SIGNATURE} réfléchit…`}
                </p>
              </div>
            )}
          {erreurStream && (
            <p role="status" className="rounded-lg border border-correction/30 bg-correction-soft px-3 py-2 text-sm text-correction">
              {erreurStream} — relance ta question pour réessayer.
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

/** Barre d'onglets de discussion (WAI-ARIA tabs) : navigation par
 * Flèches gauche/droite + Home/End, fermeture par un VRAI bouton séparé
 * (l'ancien `<span role="button">` imbriqué dans un `<button>` était
 * invalide et injoignable au clavier). L'onglet actif scroll dans la zone
 * visible à chaque changement. */
function ConversationTabs({
  conversations,
  activeId,
  onOpen,
  onClose,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  useEffect(() => {
    if (!activeId) return;
    tabRefs.current.get(activeId)?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [activeId]);

  function focusTab(id: string) {
    tabRefs.current.get(id)?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent, id: string) {
    const idx = conversations.findIndex((c) => c.id === id);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const next = conversations[(idx + delta + conversations.length) % conversations.length];
      onOpen(next.id);
      focusTab(next.id);
    } else if (e.key === "Home") {
      e.preventDefault();
      onOpen(conversations[0].id);
      focusTab(conversations[0].id);
    } else if (e.key === "End") {
      e.preventDefault();
      onOpen(conversations[conversations.length - 1].id);
      focusTab(conversations[conversations.length - 1].id);
    }
  }

  return (
    <div role="tablist" aria-label="Discussions ouvertes" className="scrollbar-hover flex gap-1.5 overflow-x-auto px-3 py-2">
      {conversations.map((c) => {
        const active = activeId === c.id;
        return (
          <div
            key={c.id}
            className={`flex min-h-[44px] shrink-0 items-center rounded-full py-1 pr-1 pl-3 text-xs ${
              active ? "bg-highlight text-highlight-ink" : "text-ink-soft"
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              ref={(el) => {
                if (el) tabRefs.current.set(c.id, el);
                else tabRefs.current.delete(c.id);
              }}
              onClick={() => onOpen(c.id)}
              onKeyDown={(e) => onKeyDown(e, c.id)}
              className="max-w-[110px] truncate"
            >
              {c.label}
            </button>
            <button
              type="button"
              aria-label={`Fermer la discussion ${c.label}`}
              onClick={() => {
                onClose(c.id);
                requestAnimationFrame(() => focusTab(activeId ?? ""));
              }}
              className="relative flex h-6 w-6 items-center justify-center rounded-full hover:bg-ink/10 after:absolute after:-inset-2.5 after:rounded-full after:content-['']"
            >
              <X size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Bulle de message : avatar + auteur + horodatage (HH:MM, date complète
 * au survol via `title`) + contenu Markdown (rounded-2xl réservé aux
 * bulles par le référentiel).
 *
 * Actions selon le rôle :
 * - élève : « Modifier » — édition inline de la question puis régénération
 *   de la discussion À PARTIR de ce point ;
 * - assistant : « Sauvegarder en note » et, pour la DERNIÈRE bulle,
 *   « Réessayer » (relance la même question). */
function ChatBubble({
  m,
  questionContexte,
  userNom,
  onSaveAsNote,
  peutSauvegarder,
  estDernier,
  enCours,
  onEditer,
  onRegenerer,
}: {
  m: Message;
  questionContexte: string;
  userNom: string;
  onSaveAsNote?: (contenu: string, contexte: string) => void;
  peutSauvegarder: boolean;
  estDernier: boolean;
  enCours: boolean;
  onEditer?: (contenu: string) => void;
  onRegenerer?: () => void;
}) {
  const isUser = m.role === "user";
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(m.content);

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
      <Avatar role={m.role} nom={isUser ? userNom : ASSISTANT_SIGNATURE} />
      <div className="min-w-0 max-w-[78%]">
        <p className={`mb-0.5 flex items-center gap-1.5 font-mono-tag text-[10px] text-slate ${isUser ? "flex-row-reverse" : ""}`}>
          <span>{isUser ? userNom : ASSISTANT_SIGNATURE}</span>
          {/* Horodatage : HH:MM à côté du nom, date complète au survol. */}
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
        {!editing && (
          <div className="mt-0.5 flex flex-wrap gap-x-3">
            {/* Édition de la question et régénération depuis ce point. */}
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
            {/* Sauvegarde d'une réponse en note personnelle (uniquement les
                réponses non vides de l'assistant, acheminées par le lecteur ;
                masquée si l'élève a refusé le stockage de ses notes). */}
            {!isUser && m.content.trim() && onSaveAsNote && peutSauvegarder && (
              <button
                type="button"
                onClick={() => onSaveAsNote(m.content, questionContexte)}
                title="Sauvegarder cette réponse dans tes notes"
                className="relative inline-flex items-center gap-1 font-mono-tag text-[10px] text-slate hover:text-ink after:absolute after:-inset-[10px] after:content-['']"
              >
                <StickyNote size={11} strokeWidth={1.75} aria-hidden="true" />
                Sauvegarder en note
              </button>
            )}
            {/* Relance de la dernière question (dernière bulle seulement). */}
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

/** Champ de question + bouton d'envoi. Le textarea est une zone de TEXTE
 * → rayon `rounded-[2px]` du référentiel (et non rounded-2xl, réservé aux
 * bulles). Nom accessible via aria-label (pas de libellé visible). Tant
 * qu'une réponse est en cours, l'envoi est TOUJOURS possible : la question
 * part en file d'attente (`queueCount` visible au-dessus du champ). */
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
        <p role="status" className="flex items-center gap-1.5 px-3 pt-2 font-mono-tag text-[10px] text-slate">
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
          placeholder="Pose ta question… (Maj+Entrée pour une nouvelle ligne)"
          aria-label="Question à Tuteur IA Prep"
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

/** Avatar rond distinguant l'élève de l'assistant dans le fil de
 * discussion — l'un et l'autre utilisent des tokens de couleur adaptatifs
 * (jamais de fixe) pour rester lisibles dans les deux thèmes. L'élève
 * porte ses INITIALES (comme l'en-tête et la page profil), l'assistant
 * l'icône robot. */
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
