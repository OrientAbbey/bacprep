import { BASE_URL } from "../api/client";
import type { Conversation } from "../components/AssistantPanel";

/**
 * Consomme un flux Server-Sent Events produit par un endpoint `POST` qui
 * répond `text/event-stream`.
 *
 * On utilise `fetch` + `ReadableStream` directement (pas `EventSource`, qui
 * ne supporte que les requêtes GET sans corps et ne permet pas d'envoyer de
 * cookies inter-origines facilement dans tous les navigateurs) : chaque
 * évènement SSE (`data: {...}\n\n`) est découpé manuellement du flux de
 * texte reçu, puis transmis à `onEvent` déjà parsé en JSON.
 */
export async function streamEventSource<T>(
  url: string,
  body: unknown,
  onEvent: (event: T) => void
): Promise<void> {
  const res = await fetch(`${BASE_URL}${url}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    // Le contrat SSE attend que l'erreur applicative passe par onEvent
    // (type "error"). L'échec HTTP/transport, lui, REJETTE le fetch : les
    // appelants distinguent ainsi une panne réseau d'une erreur applicative
    // (et les statuts 4xx d'un 5xx transitoire, pour le comportement de
    // reconnexion automatique). Le statut HTTP est attaché à l'erreur.
    const err = new Error(`Le serveur a répondu ${res.status}.`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function parseEvent(raw: string): void {
    const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) return;
    const jsonText = dataLine.slice("data:".length).trim();
    if (!jsonText) return;

    try {
      onEvent(JSON.parse(jsonText));
    } catch {
      // Fragment JSON incomplet ou invalide — ignoré plutôt que de
      // faire planter tout le flux pour une ligne malformée.
    }
  }

  function processBuffer(): void {
    // Normaliser CRLF → LF pour que le découpage sur "\n\n" fonctionne
    // même si le serveur envoie des\r\n (certains implémentations SSE).
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      parseEvent(rawEvent);
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    processBuffer();
    if (done) break;
  }

  // Dernier événement : le serveur peut fermer le flux après le dernier
  // champ `data:` SANS le séparateur "\n\n" final. `processBuffer` n'a
  // alors rien consommé — on parse le résidu tel quel.
  if (buffer.trim()) parseEvent(buffer);
}

/** Charge utile de la question. Deux voies exclusives (cf. `AskIn` backend) :
 * - persistée : `conversation_id` (l'échange est stocké — consentement IA) ;
 * - éphémère : `epreuve_id` + `contexte` + `historique`, sans
 *   `conversation_id` (refus du consentement — rien n'est persisté,
 *   `done.conversation` vaut alors null). */
export interface AssistantAskPayload {
  conversation_id?: string;
  epreuve_id?: string;
  contexte?: string;
  historique?: { role: string; content: string }[];
  message: string;
}

export type AssistantStreamEvent =
  | { type: "chunk"; text: string }
  | { type: "done"; conversation: Conversation | null }
  | { type: "error"; message: string };

export async function streamAssistantAsk(
  payload: AssistantAskPayload,
  onEvent: (event: AssistantStreamEvent) => void
): Promise<void> {
  // Les erreurs de TRANSPORT (fetch rejeté) et HTTP (statut non-2xx)
  // se propagent par rejet (avec `.status` pour les HTTP) — les panneaux
  // les distinguent ainsi des erreurs applicatives, qui elles arrivent en
  // évènement `error` du flux SSE. Un flux qui se ferme SANS `done` ni
  // `error` (connexion interrompue en plein vol) résout sans évènement :
  // l'appelant détecte l'absence de `done` pour déclencher la reconnexion.
  await streamEventSource("/api/assistant/ask/stream", payload, onEvent);
}

/** Délai d'attente (ms) avant une tentative de reconnexion, croissant avec
 * le numéro de l'essai (1 → 1200 ms, 2 → 2400 ms, …, plafonné à 8 s). */
export function delaiReconnexion(essai: number): number {
  return Math.min(1200 * 2 ** (essai - 1), 8000);
}

/**
 * Conversation « roulante » de l'assistant admin, persistée côté serveur par
 * (email admin, épreuve). Restituée à la réouverture du tiroir (`id`,
 * `label`, `messages`) via `GET /api/admin/assistant/conversation/{epreuve_id}`.
 */
export interface AdminConversation {
  id: string;
  epreuve_id: string;
  label: string;
  messages: { role: "user" | "assistant"; content: string; ts?: string }[];
  created_at: string;
  updated_at: string;
}

/**
 * Charge utile de l'assistant ADMIN : la question de l'admin + un instantané
 * du formulaire d'épreuve en cours (`epreuve`, forme du formulaire
 * d'édition : niveau, classe, evaluation, matiere, annee, session, duree,
 * coefficient, gratuit, statut, filieres, contenu_markdown,
 * corrige_markdown). Deux voies :
 * - persistée : `epreuve_id` (id de l'épreuve EN SAUVEGARDE) — l'échange est
 *   stocké côté serveur et `done.conversation` porte la conversation mise à
 *   jour ;
 * - éphémère : sans `epreuve_id` (épreuve pas encore enregistrée) — rien
 *   n'est persisté, `done.conversation` vaut null.
 * `historique` = l'état des messages attendu par le SÉRVEUR (base de
 * réconciliation) : les messages persistés doivent lui être ramenés avant
 * chaque tentative, ce qui neutralise les doublons d'une réponse interrompue.
 */
export interface AdminAskPayload {
  question: string;
  historique: { role: string; content: string }[];
  epreuve: Record<string, unknown>;
  epreuve_id?: string;
}

export type AdminStreamEvent =
  | { type: "chunk"; text: string }
  | { type: "done"; conversation: AdminConversation | null }
  | { type: "error"; message: string };

/** Flux de l'assistant admin (`POST /api/admin/assistant/ask`). Les erreurs
 * HTTP (ex. 401 sans session admin) se propagent par rejet du fetch ; les
 * erreurs applicatives arrivent en évènement `error` du flux. */
export async function streamAdminAsk(
  payload: AdminAskPayload,
  onEvent: (event: AdminStreamEvent) => void
): Promise<void> {
  await streamEventSource("/api/admin/assistant/ask", payload, onEvent);
}