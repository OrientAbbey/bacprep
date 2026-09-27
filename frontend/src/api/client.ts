const BASE_URL = import.meta.env.VITE_API_URL || "";

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    super(`Erreur API ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

/** Erreur « délai dépassé » : distincte d'une panne réseau pour que
 * l'interface puisse expliquer la cause au lieu d'afficher un échec opaque. */
export class ApiTimeoutError extends Error {
  constructor(ms: number) {
    super(`Le serveur n'a pas répondu dans le délai imparti (${Math.round(ms / 1000)} s).`);
    this.name = "ApiTimeoutError";
  }
}

/**
 * Corps lu UNE SEULE FOIS. `res.json()` puis `res.text()` en secours ne peut
 * pas marcher : le premier appel consomme le flux, le second rejette sur un
 * corps déjà lu et son `.catch` renvoyait `null` — le message d'erreur du
 * serveur (ex. « épreuve retirée ») était donc systématiquement perdu sur
 * une réponse d'erreur qui n'était pas du JSON.
 */
async function parseError(res: Response): Promise<ApiError> {
  const texte = await res.text().catch(() => "");
  if (!texte) return new ApiError(res.status, null);
  try {
    return new ApiError(res.status, JSON.parse(texte));
  } catch {
    return new ApiError(res.status, texte);
  }
}

/** Délai au-delà duquel une requête non-SSE est abandonnée. */
const TIMEOUT_DEFAUT_MS = 15_000;

/**
 * Combine le `signal` de l'appelant avec un délai d'attente interne.
 * Implémenté à la main plutôt qu'avec `AbortSignal.any`/`AbortSignal.timeout`
 * (support plus large) et surtout pour pouvoir distinguer « l'appelant a
 * annulé » de « le délai a expiré » : seule la seconde est une erreur à
 * signaler à l'utilisateur.
 */
function signauxCombines(externe: AbortSignal | null | undefined) {
  const interne = new AbortController();
  let expire = false;
  const minuterie = setTimeout(() => {
    expire = true;
    interne.abort();
  }, TIMEOUT_DEFAUT_MS);
  const surAbort = () => interne.abort();
  if (externe) {
    if (externe.aborted) interne.abort();
    else externe.addEventListener("abort", surAbort, { once: true });
  }
  return {
    signal: interne.signal,
    expire: () => expire,
    liberer: () => {
      clearTimeout(minuterie);
      externe?.removeEventListener("abort", surAbort);
    },
  };
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { headers, body, ...rest } = options;
  // IMPORTANT : fusionner les en-têtes (headers) après avoir étalé `rest`,
  // sans jamais étaler `options` (qui contient déjà `headers`) par-dessus un
  // objet headers déjà construit — sinon Content-Type est silencieusement
  // écrasé dès qu'un appel fournit ses propres en-têtes.
  // `Content-Type: application/json` n'a de sens qu'AVEC un corps : sur un GET
  // ou un DELETE sans corps, il annonce à tort le type de la requête et peut
  // déclencher un preflight CORS inutile.
  const comb = signauxCombines(rest.signal as AbortSignal | undefined);
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      credentials: "include",
      ...rest,
      body,
      signal: comb.signal,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(headers || {}),
      },
    });
  } catch (err) {
    // Annulation demandée par l'appelant : ce n'est pas une panne, on laisse
    // remonter tel quel pour qu'il distingue le cas.
    if (rest.signal?.aborted) throw err;
    if (comb.expire()) throw new ApiTimeoutError(TIMEOUT_DEFAUT_MS);
    throw err;
  } finally {
    comb.liberer();
  }

  if (!res.ok) throw await parseError(res);

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  // `signal` : AbortSignal pour annuler une requête devenue obsolète
  // (navigation, changement de filtre) — voir ViewerPage/CataloguePage.
  get: <T>(path: string, headers?: Record<string, string>, signal?: AbortSignal) =>
    request<T>(path, { method: "GET", headers, signal }),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal) =>
    request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined, headers, signal }),
  put: <T>(path: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal) =>
    request<T>(path, { method: "PUT", body: body !== undefined ? JSON.stringify(body) : undefined, headers, signal }),
  patch: <T>(path: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal) =>
    request<T>(path, {
      method: "PATCH",
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers,
      signal,
    }),
  del: <T>(path: string, headers?: Record<string, string>, signal?: AbortSignal) =>
    request<T>(path, { method: "DELETE", headers, signal }),
  upload: async <T>(
    path: string,
    formData: FormData,
    headers?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<T> => {
    // `Content-Type` laissé à fetch : il doit porter la frontière
    // multipart, un en-tête explicite la casserait.
    const comb = signauxCombines(signal);
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        credentials: "include",
        body: formData,
        signal: comb.signal,
        headers: headers || {},
      });
      if (!res.ok) throw await parseError(res);
      return res.json();
    } catch (err) {
      if (signal?.aborted) throw err;
      if (comb.expire()) throw new ApiTimeoutError(TIMEOUT_DEFAUT_MS);
      throw err;
    } finally {
      comb.liberer();
    }
  },
};

export { BASE_URL };

/**
 * Résout une URL de média potentiellement relative (`/media/...`, servie
 * par le backend) en une URL absolue utilisable telle quelle dans un
 * attribut `src`. Nécessaire en développement, où frontend (5173) et
 * backend (8000) tournent sur des origines différentes : une URL relative
 * comme `/media/xxx.png` se résoudrait sinon contre l'origine du
 * FRONTEND, où le fichier n'existe pas (image cassée). En production
 * (service unifié, voir DEPLOIEMENT.md), BASE_URL est une chaîne vide et
 * cette fonction est un no-op (les chemins relatifs fonctionnent déjà
 * puisque tout est servi depuis la même origine).
 */
export function resolveMediaUrl(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//.test(url)) return url; // déjà absolue
  if (!BASE_URL) return url; // production : même origine, rien à faire
  return `${BASE_URL}${url.startsWith("/") ? "" : "/"}${url}`;
}

/**
 * Ajoute (ou vérifie) une option du référentiel — BEST-EFFORT : sert aux
 * auto-ajouts des formulaires (série/matière saisies hors liste).
 * L'échec (option déjà présente, réseau, 401) est SILENCIEUX pour ne
 * jamais bloquer une sauvegarde d'épreuve. `headers` doit porter
 * l'authentification admin (voir authHeaders) pour les voies admin.
 */
export async function ensureReferentielOption(
  scope: string,
  code: string,
  headers?: Record<string, string>
): Promise<void> {
  if (!code || !code.trim()) return;
  try {
    await api.post("/api/admin/referentiel-options", { scope, code }, headers);
  } catch {
    // Best-effort volontaire : aucune erreur ne doit bloquer l'appelant.
  }
}
