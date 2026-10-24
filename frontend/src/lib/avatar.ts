import { ApiError, BASE_URL } from "../api/client";
import { t } from "../i18n";

const MAX_OCTETS = 2 * 1024 * 1024; // même plafond que le serveur

const MESSAGES: Record<number, () => string> = {
  413: () => t("Photo trop lourde (2 Mo maximum)"),
  415: () => t("Fichier non reconnu comme image (PNG, JPEG, WebP ou GIF)"),
  429: () => t("Trop d'envois de photo — réessaie plus tard"),
};

/** Message pour un refus du serveur (413, 415, 429) ; générique pour toute autre erreur. */
export const messagePhoto = (statut: number) => (MESSAGES[statut] ?? (() => t("L'envoi de la photo a échoué — réessaie.")))();
export const messageEnvoiPhoto = (err: unknown) => messagePhoto(err instanceof ApiError ? err.status : 0);

/** `?v=` : une nouvelle photo change l'URL, donc contourne le cache de 7 jours du serveur. */
export const urlAvatar = (version: string) => `${BASE_URL}/api/me/avatar?v=${encodeURIComponent(version)}`;

/** Refus immédiat, sans envoi, d'un fichier que le serveur refuserait de toute façon ; `null` s'il peut partir. */
export function refusPhoto(fichier: { size: number; type: string }): string | null {
  if (!fichier.type.startsWith("image/")) return messagePhoto(415);
  return fichier.size > MAX_OCTETS ? messagePhoto(413) : null;
}
