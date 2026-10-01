/** Logique pure de l'onglet « Sauvegardes » (aucune dépendance React).
 *
 * Ce fichier existe pour une raison précise : la RÈGLE DE SÉCURITÉ de la
 * restauration y est testable. « Une écriture n'est proposée qu'après un essai
 * à blanc sans anomalie » est l'invariant qui protège le catalogue d'un
 * catalogue d'un clic ; l'écrire dans un composant le rendrait invérifiable.
 */

/** Sous-ensemble d'un rapport de job : les seules clés utilisées par les
 *  règles ci-dessous. Typage volontairement partiel — un rapport réel contient
 *  bien plus (parties, epreuves, deja_presents…). */
export interface RapportPartiel {
  dry_run?: boolean;
  introuvables?: unknown[];
  incoherences?: unknown[];
  corrompues?: unknown[];
  erreurs?: unknown[];
  [cle: string]: unknown;
}

/** Nombre d'anomalies d'un rapport.
 *
 *  `erreurs` y compte : une partie abandonnée (structure ambiguë) laisse des
 *  fichiers de côté sans jamais passer par `introuvables`, et l'ignorer
 *  autoriserait une écriture sur une restauration qui a déjà perdu des
 *  fichiers.
 */
export function nombreAnomalies(rapport: RapportPartiel | null | undefined): number {
  if (!rapport) return 0;
  return (
    (rapport.introuvables?.length ?? 0) +
    (rapport.incoherences?.length ?? 0) +
    (rapport.corrompues?.length ?? 0) +
    (rapport.erreurs?.length ?? 0)
  );
}

/** L'écriture réelle est-elle proposable ? Trois conditions, toutes
 *  nécessaires :
 *
 *  1. un rapport existe ET c'était bien un essai à blanc (`dry_run`) — un
 *     export terminé ne se « restaure » pas ;
 *  2. le job n'a pas échoué — un statut `error` signifie des métadonnées non
 *     écrites ;
 *  3. le rapport ne signale AUCUNE anomalie.
 *
 *  Renvoie `false` dès qu'une information manque : mieux vaut un bouton
 *  d'écriture absent qu'un bouton qui vide un catalogue par défaut.
 */
export function ecritureAutorisee(
  rapport: RapportPartiel | null | undefined,
  statut: string
): boolean {
  if (!rapport) return false;
  if (statut !== "done") return false;
  if (rapport.dry_run !== true) return false;
  return nombreAnomalies(rapport) === 0;
}

/** Un essai à blanc ne vaut que pour CE QU'IL A DÉCRIT.
 *
 *  Un rapport d'essai est un ensemble de chiffres : « 40 fichiers, 12 déjà
 *  présents, 28 à écrire ». Si l'utilisateur change de mode ou de sauvegarde
 *  après l'essai, ces chiffres ne sont plus ceux de l'opération qui va
 *  partir — et rien dans le rapport ne le signale. `bucket` et `disaster` ne
 *  touchent pas aux mêmes choses : un essai en `bucket` ne dit rien de ce que
 *  `disaster` réécrirait en base.
 *
 *  D'où cette règle, distincte de `ecritureAutorisee` : l'essai doit
 *  correspondre à la fois à la sauvegarde ET au mode actuellement
 *  sélectionnés. Renvoie `false` dès qu'une des deux ne correspond pas, y
 *  compris si le job ne porte pas encore ces informations.
 */
export function essaiConcerne(
  job: { source?: string; mode?: string } | null | undefined,
  choix: { source: string; mode: string }
): boolean {
  if (!job) return false;
  return job.source === choix.source && job.mode === choix.mode;
}

/** Pourcentage d'avancement, borné à [0, 100].
 *
 *  Borné, et non simplement calculé : un compteur qui dépasse le total
 *  (arrondi, octets incohérents) rendrait une barre plus large que son cadre,
 *  et 0/0 doit rester 0 plutôt que NaN.
 */
export function pourcentage(fait: number, total: number): number {
  if (!Number.isFinite(fait) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((fait / total) * 100)));
}

/** Bornes d'affichage d'une empreinte : un SHA-256 complet (64 caractères)
 *  déborde une ligne de liste. Les 12 premiers caractères suffisent à comparer
 *  deux sauvegardes à l'œil ; la valeur entière reste disponible en
 *  info-bulle pour un copier-coller. */
export function empreinteCourte(sha: string | null | undefined): string {
  return sha ? `${sha.slice(0, 12)}…` : "—";
}
