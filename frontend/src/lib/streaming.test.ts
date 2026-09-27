import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamAdminAsk, streamAssistantAsk } from "./streaming";

/** Réponse SSE construite à partir de fragments réseau arbitraires — permet
 * de tester le découpage/colmatage du tampon de `streamEventSource`
 * (évènements découpés en pleine ligne, CRLF, absence de séparateur final). */
function sseResponse(parts: (string | Uint8Array)[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
      controller.close();
    },
  });
  return new Response(stream, { status });
}

function readEvent(request: readonly unknown[]): string {
  const body = request[1] as { body?: string } | undefined;
  return typeof body?.body === "string" ? body.body : "";
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("streamAdminAsk — décodage du flux admin", () => {
  it("adresse bien /api/admin/assistant/ask avec la charge utile éphémère", async () => {
    fetchMock.mockResolvedValue(sseResponse([]));
    await streamAdminAsk(
      { question: "Q", historique: [{ role: "user", content: "R1" }], epreuve: { matiere: "X" } },
      vi.fn()
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/assistant/ask"),
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
    const call = fetchMock.mock.calls[0];
    expect(JSON.parse(readEvent(call))).toEqual({
      question: "Q",
      historique: [{ role: "user", content: "R1" }],
      epreuve: { matiere: "X" },
    });
  });

  it("décode chunk puis done (conversation null) d'un flux découpé en pleine ligne", async () => {
    // Le JSON du premier évènement est coupé au milieu, le séparateur \n\n
    // coupe entre ses deux retours à la ligne : le tampon doit colmater.
    fetchMock.mockResolvedValue(
      sseResponse([
        'data:{"type":"chunk","',
        'text":"Bonjour"}\n',
        '\ndata:{"type":"done","conversation":null}',
        "\n\n",
      ])
    );
    const events: unknown[] = [];
    await streamAdminAsk({ question: "Q", historique: [], epreuve: {} }, (e) => events.push(e));
    expect(events).toEqual([
      { type: "chunk", text: "Bonjour" },
      { type: "done", conversation: null },
    ]);
  });

  it("normalise les retours CRLF du serveur", async () => {
    fetchMock.mockResolvedValue(
      sseResponse(['data:{"type":"chunk","text":"abc"}\r\n\r\ndata:{"type":"done","conversation":null}\r\n\r\n'])
    );
    const events: unknown[] = [];
    await streamAdminAsk({ question: "Q", historique: [], epreuve: {} }, (e) => events.push(e));
    expect(events[0]).toEqual({ type: "chunk", text: "abc" });
  });

  it("parse le dernier évènement sans séparateur \\n\\n final", async () => {
    fetchMock.mockResolvedValue(sseResponse(['data:{"type":"error","message":"boom"}']));
    const events: unknown[] = [];
    await streamAdminAsk({ question: "Q", historique: [], epreuve: {} }, (e) => events.push(e));
    expect(events).toEqual([{ type: "error", message: "boom" }]);
  });

  it("ignore une ligne JSON invalide sans faire planter le flux", async () => {
    fetchMock.mockResolvedValue(
      sseResponse(['data:{invalide\n\ndata:{"type":"done","conversation":null}\n\n'])
    );
    const events: unknown[] = [];
    await streamAdminAsk({ question: "Q", historique: [], epreuve: {} }, (e) => events.push(e));
    expect(events).toEqual([{ type: "done", conversation: null }]);
  });

  it("rejette sur erreur HTTP (ex. 401 sans session admin)", async () => {
    fetchMock.mockResolvedValue(sseResponse([], 401));
    await expect(
      streamAdminAsk({ question: "Q", historique: [], epreuve: {} }, vi.fn())
    ).rejects.toThrow("Le serveur a répondu 401.");
  });
});

describe("streamAssistantAsk — propagation des erreurs de transport", () => {
  it("adresse /api/assistant/ask/stream avec la charge utile", async () => {
    fetchMock.mockResolvedValue(sseResponse([]));
    await streamAssistantAsk(
      { conversation_id: "c1", message: "Q" },
      vi.fn()
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/assistant/ask/stream"),
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
  });

  it("transmet l'évènement error du flux tel quel", async () => {
    fetchMock.mockResolvedValue(sseResponse(['data:{"type":"error","message":"boom"}']));
    const events: unknown[] = [];
    await streamAssistantAsk({ message: "Q" }, (e) => events.push(e));
    expect(events).toEqual([{ type: "error", message: "boom" }]);
  });

  it("rejette sur erreur HTTP en attachant le statut (reconnexion)", async () => {
    fetchMock.mockResolvedValue(sseResponse([], 503));
    let captured: (Error & { status?: number }) | undefined;
    try {
      await streamAssistantAsk({ message: "Q" }, vi.fn());
    } catch (e) {
      captured = e as Error & { status?: number };
    }
    expect(captured).toBeDefined();
    expect(captured!.message).toContain("503");
    expect(captured!.status).toBe(503);
  });

  it("attache le detail du corps (HTTPException) sur une erreur 4xx ou 5xx", async () => {
    // Le backend répond 403 avec le message EXPLICITE (« épreuve retirée »,
    // paywall, consentement…) : il doit être transporté jusqu'au panneau
    // pour remplacer le statut brut « Erreur API 403 ».
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Cette épreuve ne peut plus être utilisée pour le moment." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );
    let captured: (Error & { status?: number; detail?: unknown }) | undefined;
    try {
      await streamAssistantAsk({ conversation_id: "c1", message: "Q" }, vi.fn());
    } catch (e) {
      captured = e as Error & { status?: number; detail?: unknown };
    }
    expect(captured).toBeDefined();
    expect(captured!.status).toBe(403);
    expect(captured!.detail).toEqual({
      detail: "Cette épreuve ne peut plus être utilisée pour le moment.",
    });
  });

  it("rejette sur panne réseau (fetch rejeté)", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(streamAssistantAsk({ message: "Q" }, vi.fn())).rejects.toThrow();
  });
});

describe("streamEventSource — annulation", () => {
  /** Flux qui n'envoie RIEN puis reste ouvert : c'est le cas réel d'une
   * réponse LLM en cours quand l'utilisateur ferme le panneau. */
  function hangingResponse(): { response: Response; fermer: () => void } {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      })
    );
    return { response, fermer: () => controller.close() };
  }

  it("transmet le signal à fetch (annulation de la requête HTTP)", async () => {
    fetchMock.mockResolvedValue(sseResponse([]));
    const controller = new AbortController();
    await streamAdminAsk({ question: "Q", historique: [], epreuve: {} }, vi.fn(), controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it("sort de la boucle même si le serveur n'envoie plus rien", async () => {
    // Régression : `reader.read()` restait en attente indéfiniment, la
    // promesse ne se résolvait jamais et la boucle de reconnexion du
    // panneau repartait sur un échange abandonné.
    const { response } = hangingResponse();
    fetchMock.mockResolvedValue(response);
    const controller = new AbortController();
    const events: unknown[] = [];
    const courant = streamAssistantAsk({ message: "Q" }, (e) => events.push(e), controller.signal);
    controller.abort();
    await expect(courant).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it("rejette sur AbortError si l'annulation survient pendant le fetch", async () => {
    const aborted = new Error("The operation was aborted.");
    aborted.name = "AbortError";
    fetchMock.mockRejectedValue(aborted);
    const controller = new AbortController();
    controller.abort();
    await expect(
      streamAssistantAsk({ message: "Q" }, vi.fn(), controller.signal)
    ).rejects.toThrow();
  });

  it("ignore les fragments arrivés après l'annulation", async () => {
    fetchMock.mockResolvedValue(
      sseResponse(['data:{"type":"chunk","text":"a"}\n\n', 'data:{"type":"chunk","text":"b"}\n\n'])
    );
    const controller = new AbortController();
    const events: unknown[] = [];
    await streamAdminAsk({ question: "Q", historique: [], epreuve: {} }, (e) => events.push(e), controller.signal);
    // Le flux terminé normalement reste livré : l'annulation n'a pas
    // tronqué la réponse si elle était déjà partie.
    expect(events).toHaveLength(2);
  });
});
