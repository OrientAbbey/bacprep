import type { ActiviteItem } from "../api/types";
import { tDynamique } from "../i18n";
import { libelleDiscussion } from "./libelleDiscussion";

/** Statuts stockés par le serveur (valeurs de la base, sans accent) : traduits
 * en mot lisible AVANT d'entrer dans le gabarit — sans cela le français
 * afficherait « Abonnement annulee — … » ou « Abonnement active — … ». */
const STATUTS: Record<string, string> = {
  active: "actif",
  annulee: "annulé",
  pending: "en attente",
  confirmed: "confirmé",
};

/** Phrase d'une entrée d'activité dans la langue choisie : gabarit et paramètres envoyés par le serveur. Les mots du
 * produit qu'ils contiennent (portée, statut, libellé de discussion) sont traduits un à un ; matière, classe et
 * montant sont des données. */
export function libelleActivite(a: ActiviteItem): string {
  if (!a.cle) return a.libelle;
  const params = Object.fromEntries(
    Object.entries(a.params ?? {}).map(([k, v]) => [
      k,
      k === "libelle"
        ? libelleDiscussion(String(v))
        : typeof v === "string"
          ? tDynamique(k === "statut" ? (STATUTS[v] ?? v) : v)
          : v,
    ]),
  );
  return tDynamique(a.cle, params);
}
