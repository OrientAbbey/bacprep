/** Logique pure du suivi des tâches longues de la console Admin.
 *
 * Deux besoins, testables sans React :
 *
 * 1. **retrouver le job à suivre** après un changement d'onglet. L'état local
 *    du panneau disparaît au démontage ; la liste renvoyée par le serveur, non.
 *    C'est elle qui permet de reprendre le suivi au retour.
 * 2. **afficher une durée lisible** et la phase en cours. Une durée brute en
 *    millisecondes ne dit rien ; « 2 min 07 s » si.
 */

/** Champs communs aux jobs d'import et de sauvegarde. Volontairement partiel :
 *  le composant peut passer son type complet, seul ce sous-ensemble est lu. */
export interface JobSuivi {
  id: string;
  status: string;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
}

/** États pendant lesquels un job travaille encore. `done` et `error` sont
 *  terminaux : les rattacher au montage afficherait un rapport ancien comme
 *  s'il venait de se produire. */
export const STATUTS_ACTIFS = new Set(["pending", "running"]);

export function estActif(job: JobSuivi | null | undefined): boolean {
  return !!job && STATUTS_ACTIFS.has(job.status);
}

function instant(iso: string | null | undefined): number {
  if (!iso) return 0;
  const valeur = Date.parse(iso);
  return Number.isNaN(valeur) ? 0 : valeur;
}

/** Le job actif le plus récent, ou `null`.
 *
 *  Trier explicitement sur `created_at` plutôt que de faire confiance à
 *  l'ordre de la réponse : la route peut changer de tri sans que l'écran le
 *  sache, et suivre un job plus ancien qu'un autre afficherait une progression
 *  qui n'est pas celle du lancement courant.
 */
export function choisirJobASuivre<T extends JobSuivi>(
  jobs: readonly T[] | null | undefined
): T | null {
  if (!jobs || jobs.length === 0) return null;
  let choisi: T | null = null;
  for (const job of jobs) {
    if (!estActif(job)) continue;
    if (choisi === null || instant(job.created_at) >= instant(choisi.created_at)) {
      choisi = job;
    }
  }
  return choisi;
}

/** Durée écoulée depuis un horodatage de début, en millisecondes.
 *
 *  `maintenant` est un paramètre pour que le test n'attende pas une horloge
 *  réelle. Retourne `null` si le début est absent ou illisible. */
export function dureeEcoulee(
  debut: string | null | undefined,
  maintenant: number = Date.now()
): number | null {
  if (!debut) return null;
  const depart = Date.parse(debut);
  if (Number.isNaN(depart)) return null;
  return Math.max(0, maintenant - depart);
}

/** Durée lisible : « 850 ms », « 4,2 s », « 2 min 07 s », « 1 h 03 min ».
 *
 *  `null` reste `null` : l'appelant décide de ne rien afficher plutôt que de
 *  montrer un « 0 s » qui laisserait croire à une opération instantanée. */
export function dureeLisible(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const secondes = ms / 1000;
  if (secondes < 60) {
    return `${secondes.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`;
  }
  const total = Math.floor(secondes);
  const minutes = Math.floor(total / 60);
  const reste = total % 60;
  if (minutes < 60) {
    return `${minutes} min ${String(reste).padStart(2, "0")} s`;
  }
  const heures = Math.floor(minutes / 60);
  return `${heures} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Durée d'un job : durée serveur si elle existe, sinon calculée.
 *
 *  Le serveur est la référence quand il a mesuré (`duration_ms`). À défaut,
 *  on retombe sur `finished_at - started_at`, puis sur le temps écoulé pour
 *  un job encore actif. Un job `pending` compte depuis sa demande : c'est le
 *  temps que l'administrateur attend, même si le worker n'a pas commencé. */
export function dureeJob(job: JobSuivi, maintenant: number = Date.now()): number | null {
  if (job.duration_ms !== null && job.duration_ms !== undefined) {
    return job.duration_ms;
  }
  const debut = job.started_at ?? job.created_at;
  if (job.finished_at) {
    const fin = Date.parse(job.finished_at);
    if (!Number.isNaN(fin)) return dureeEcoulee(debut, fin);
  }
  if (estActif(job)) return dureeEcoulee(debut, maintenant);
  return null;
}

/** Libellé français d'une phase serveur. Une phase inconnue est rendue telle
 *  quelle plutôt que masquée : mieux vaut un identifiant technique visible
 *  qu'une étape qui disparaît de l'écran. */
export function libellePhase(phase: string | null | undefined): string | null {
  if (!phase) return null;
  const libelles: Record<string, string> = {
    manifeste: "Préparation du manifeste",
    lecture: "Lecture et compression",
    upload: "Envoi des parties",
    index: "Écriture de l’index",
    finalisation: "Finalisation",
    verification: "Vérification",
    ecriture: "Écriture des fichiers",
  };
  return libelles[phase] ?? phase;
}

/** Job enrichi des seuls champs dont le bandeau global a besoin. */
export interface JobOperation extends JobSuivi {
  kind?: string;
  phase?: string;
  filename?: string;
  source?: string;
  destination?: string;
}

export type OngletOperation = "sauvegardes" | "import";

export interface OperationEnCours {
  id: string;
  type: "export" | "restore" | "import";
  libelle: string;
  detail: string;
  phase: string | null;
  duree: number | null;
  onglet: OngletOperation;
}

/** Opérations encore actives, tous types confondus, pour le bandeau global.
 *
 *  Le bandeau ne dépend PAS de l'onglet affiché : c'est tout son intérêt.
 *  Auparavant, quitter « Sauvegardes » pendant un export faisait disparaître
 *  toute trace de l'opération ; ici la liste serveur reste la source de vérité.
 *  Les jobs terminaux sont exclus : un rapport ancien n'est pas une opération
 *  « en cours ».
 */
export function operationsEnCours(
  sauvegardes: readonly JobOperation[] | null | undefined,
  imports: readonly JobOperation[] | null | undefined,
  maintenant: number = Date.now()
): OperationEnCours[] {
  const operations: OperationEnCours[] = [];

  function ajouter(
    job: JobOperation,
    type: OperationEnCours["type"],
    onglet: OngletOperation,
    libelle: string,
    detail: string
  ) {
    if (!estActif(job)) return;
    operations.push({
      id: job.id,
      type,
      libelle,
      detail,
      phase: libellePhase(job.phase),
      duree: dureeJob(job, maintenant),
      onglet,
    });
  }

  for (const job of sauvegardes ?? []) {
    if (job.kind === "restore") {
      ajouter(job, "restore", "sauvegardes", "Restauration du catalogue", job.source ?? "");
    } else {
      ajouter(job, "export", "sauvegardes", "Sauvegarde du catalogue", job.destination ?? "");
    }
  }
  for (const job of imports ?? []) {
    ajouter(job, "import", "import", "Import massif", job.filename ?? "");
  }

  // Le plus long d'abord : c'est celui qui risque de bloquer l'administrateur.
  operations.sort((a, b) => (b.duree ?? 0) - (a.duree ?? 0));
  return operations;
}
