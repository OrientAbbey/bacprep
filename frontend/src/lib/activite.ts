import type { ActiviteItem } from "../api/types";
import { t } from "../i18n";
import { libelleDiscussion } from "./libelleDiscussion";

/** Phrase d'une entrée d'activité dans la langue choisie : gabarit et paramètres envoyés par le serveur. Les mots du
 * produit qu'ils contiennent (portée, statut, libellé de discussion) sont traduits un à un ; matière, classe et
 * montant sont des données. */
export function libelleActivite(a: ActiviteItem): string {
  if (!a.cle) return a.libelle;
  const params = Object.fromEntries(
    Object.entries(a.params ?? {}).map(([k, v]) => [k, k === "libelle" ? libelleDiscussion(String(v)) : typeof v === "string" ? t(v) : v]),
  );
  return t(a.cle, params);
}
