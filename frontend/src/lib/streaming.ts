import { BASE_URL } from "../api/client";

/**
 * Consomme un flux Server-Sent Events produit par `POST /api/assistant/ask/stream`.
 *
 * On utilise `fetch` + `ReadableStream` directement (pas `EventSource`, qui
 * ne supporte que les requêtes GET sans corps et ne permet pas d'envoyer de
 * cookies inter-origines facilement dans tous les navigateurs) : chaque
 * évènement SSE (`data: {...}\n\n`) est découpé manuellement du flux de
 * texte reçu, puis transmis à `onEvent` déjà parsé en JSON.
 *
 * Le streaming est activé PAR DÉFAUT côté frontend — c'est la seule voie
 * utilisée par AssistantPanel ; `/api/assistant/ask` (non-streaming) reste
 * disponible côté backend mais n'est plus appelé ici.
 */
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

export async function streamAssistantAsk(
  payload: AssistantAskPayload,
  onEvent: (event: { type: "chunk"; text: string } | { type: "done"; conversation: any } | { type: "error"; message: string }) => void
): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/assistant/ask/stream`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok || !res.body) {
    onEvent({ type: "error", message: `Le serveur a répondu ${res.status}.` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function processBuffer(): void {
    // Normaliser CRLF → LF pour que le découpage sur "\n\n" fonctionne
    // même si le serveur envoie des\r\n (certains implémentations SSE).
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const jsonText = dataLine.slice("data:".length).trim();
      if (!jsonText) continue;

      try {
        onEvent(JSON.parse(jsonText));
      } catch {
        // Fragment JSON incomplet ou invalide — ignoré plutôt que de
        // faire planter tout le flux pour une ligne malformée.
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    processBuffer();
    if (done) break;
  }

  // Traiter le résidu éventuel du buffer (dernier SSE sans \n\n final).
  if (buffer.trim()) processBuffer();
}
