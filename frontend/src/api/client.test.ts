import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, ApiTimeoutError } from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  vi.useRealTimers();
});

/** Réponse JSON minimale. */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const options = () => fetchMock.mock.calls[0][1] as RequestInit;

describe("client — lecture du corps de réponse", () => {
  it("renvoie le corps JSON parsé", async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await expect(api.get("/api/x")).resolves.toEqual({ ok: true });
  });

  it("renvoie undefined sur 204 sans corps", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.del("/api/x")).resolves.toBeUndefined();
  });

  it("ne tente pas de parser un corps vide en 200", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    await expect(api.get("/api/x")).resolves.toBeUndefined();
  });
});

describe("client — détail d'erreur (F-06)", () => {
  it("conserve le detail JSON d'une erreur 4xx", async () => {
    fetchMock.mockResolvedValue(json({ detail: "Cette épreuve ne peut plus être utilisée." }, 403));
    // UN SEUL appel : le mock renvoie la même Response, dont le corps est
    // consommé au premier `.text()`.
    const err = (await api.get("/api/x").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.detail).toEqual({ detail: "Cette épreuve ne peut plus être utilisée." });
  });

  it("conserve un corps d'erreur NON JSON (page HTML, proxy)", async () => {
    // Régression : `res.json()` puis `res.text()` en secours était impossible —
    // le corps déjà consommé faisait échouer le second appel, et son `.catch`
    // renvoyait null. Le message du serveur était perdu.
    fetchMock.mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    const err = (await api.get("/api/x").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.detail).toContain("502 Bad Gateway");
  });

  it("tolère un corps d'erreur vide", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    const err = (await api.get("/api/x").catch((e) => e)) as ApiError;
    expect(err.status).toBe(500);
    expect(err.detail).toBeNull();
  });
});

describe("client — en-têtes (F-06)", () => {
  it("n'envoie pas Content-Type sur une requête sans corps", async () => {
    fetchMock.mockResolvedValue(json([]));
    await api.get("/api/x");
    expect(options().headers).not.toHaveProperty("Content-Type");
  });

  it("envoie Content-Type quand le corps est présent", async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await api.post("/api/x", { a: 1 });
    expect(options().headers).toMatchObject({ "Content-Type": "application/json" });
    expect(options().body).toBe('{"a":1}');
  });

  it("ne pose pas Content-Type quand le corps est explicitement absent", async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await api.post("/api/x");
    expect(options().headers).not.toHaveProperty("Content-Type");
    expect(options().body).toBeUndefined();
  });

  it("laisse les en-têtes de l'appelant gagner", async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await api.get("/api/x", { Authorization: "Bearer jeton" });
    expect(options().headers).toMatchObject({ Authorization: "Bearer jeton" });
  });

  it("laisse fetch gérer la frontière multipart de upload", async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await api.upload("/api/upload", new FormData());
    expect(options().headers).toEqual({});
  });
});

describe("client — délai d'attente et annulation (F-06)", () => {
  it("rejette avec un message explicite quand le délai expire", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        })
    );
    const promesse = api.get("/api/lent");
    const attente = promesse.catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await attente;
    expect(err).toBeInstanceOf(ApiTimeoutError);
    expect((err as Error).message).toContain("60 s");
  });

  it("laisse remonter l'annulation de l'appelant telle quelle", async () => {
    // Un annulation demandée par l'appelant n'est pas une panne réseau :
    // le timeout interne ne doit pas la transformer en ApiTimeoutError.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        })
    );
    const ctl = new AbortController();
    const promesse = api.get("/api/obsolete", undefined, ctl.signal);
    const attente = promesse.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    ctl.abort();
    const err = await attente;
    expect(err).not.toBeInstanceOf(ApiTimeoutError);
    expect((err as Error).name).toBe("AbortError");
  });

  it("n'annule pas une requête déjà répondue avant le délai", async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await expect(api.get("/api/x")).resolves.toEqual({ ok: true });
    // Le minuteur interne doit avoir été nettoyé : plus aucune rejection
    // parasite après la résolution.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
