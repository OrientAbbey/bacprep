import { t } from "../i18n";

/** Libellé d'une discussion dans la langue choisie : les libellés par défaut sont enregistrés en français (suffixés
 * « 2 », « 3 »… quand ils se répètent), seul l'affichage est traduit. */
export function libelleDiscussion(label: string): string {
  const defaut = /^(Discussion générale)( \d+)?$/.exec(label);
  if (defaut) return t(defaut[1]) + (defaut[2] ?? "");
  return label.startsWith("Passage : ") ? t("Passage : {texte}", { texte: label.slice("Passage : ".length) }) : t(label);
}
