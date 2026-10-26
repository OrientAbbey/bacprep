import { t } from "../i18n";

/** Message explicite d'un HTTPException FastAPI (corps `{"detail": "..."}`), traduit dans la langue choisie. Il peut
 * venir de `ApiError.detail` (client.ts : le corps JSON complet) ou de l'erreur enrichie par `streamEventSource`
 * (streaming.ts). `null` si le corps ne porte pas de chaîne exploitable (ex. validation 422). */
export function detailServeur(err: unknown): string | null {
  const brut = (err as { detail?: unknown })?.detail;
  const detail = typeof brut === "string" ? brut : brut && typeof brut === "object" ? (brut as { detail?: unknown }).detail : undefined;
  return typeof detail === "string" && detail.trim() ? t(detail) : null;
}
