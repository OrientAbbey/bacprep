/** Motifs de signalement — source unique partagée par la modale élève
 * (SignalementModal) et le back-office (SignalementsPanel admin).
 * Avant : deux listes séparées à maintenir en double. */
import { t } from "../i18n";
import type { MotifSignalement } from "../api/types";

export const MOTIFS: { value: MotifSignalement; label: string }[] = [
  { value: "contenu_illisible", label: t("Contenu illisible ou mal formaté") },
  { value: "erreur_enonce", label: t("Erreur dans l'énoncé") },
  { value: "corrige_manquant", label: t("Corrigé manquant ou erroné") },
  { value: "image_cassee", label: t("Image cassée ou absente") },
  { value: "autre", label: t("Autre problème") },
];

export const MOTIF_LABELS: Record<string, string> = Object.fromEntries(
  MOTIFS.map((m) => [m.value, m.label]),
);
