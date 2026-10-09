import { ApiError, ApiTimeoutError } from "../api/client";
import { t } from "../i18n";
import { estErreurReseau } from "./connexion";

/** Message adapté à la CAUSE d'un échec de connexion : jeton refusé, délai dépassé, limite de
 * tentatives, erreur serveur ou réseau coupé — au lieu d'accuser toujours l'e-mail et le jeton. */
export function messageErreurConnexion(err: unknown, refus = t("Connexion refusée — vérifie l'e-mail et le jeton.")): string {
  if (err instanceof ApiTimeoutError) return t("Le serveur ne répond pas (délai dépassé) — réessaie dans un instant.");
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return refus;
    if (err.status === 429) return typeof err.detail === "string" ? err.detail : t("Trop de tentatives — patiente quelques minutes.");
    if (err.status >= 500) return t("Erreur du serveur — réessaie dans un instant.");
    return t("Connexion impossible (code {s}).", { s: err.status });
  }
  if (estErreurReseau(err) || (typeof navigator !== "undefined" && !navigator.onLine)) {
    return t("Pas de connexion Internet — vérifie ton réseau puis réessaie.");
  }
  return t("Connexion impossible. Réessaie dans un instant.");
}
