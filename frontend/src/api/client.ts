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

async function parseError(res: Response): Promise<ApiError> {
  let detail: unknown = null;
  try {
    detail = await res.json();
  } catch {
    detail = await res.text().catch(() => null);
  }
  return new ApiError(res.status, detail);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { headers, ...rest } = options;
  // IMPORTANT : fusionner les en-têtes (headers) après avoir étalé `rest`,
  // sans jamais étaler `options` (qui contient déjà `headers`) par-dessus un
  // objet headers déjà construit — sinon Content-Type est silencieusement
  // écrasé dès qu'un appel fournit ses propres en-têtes.
  const res = await fetch(`${BASE_URL}${path}`, {
    credentials: "include",
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(headers || {}),
    },
  });

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
  upload: async <T>(path: string, formData: FormData, headers?: Record<string, string>): Promise<T> => {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      credentials: "include",
      body: formData,
      headers: headers || {},
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
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
 * auto-ajouts des formulaires (série/matière/session saisies hors liste).
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
