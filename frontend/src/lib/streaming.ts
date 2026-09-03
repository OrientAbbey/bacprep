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
export async function streamAssistantAsk(
  conversationId: string,
  message: string,
  onEvent: (event: { type: "chunk"; text: string } | { type: "done"; conversation: any } | { type: "error"; message: string }) => void
): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/assistant/ask/stream`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId, message }),
  });

  if (!res.ok || !res.body) {
    onEvent({ type: "error", message: `Le serveur a répondu ${res.status}.` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Les évènements SSE sont séparés par une ligne vide ("\n\n").
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
}
