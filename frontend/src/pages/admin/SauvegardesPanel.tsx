import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, HardDriveDownload, RotateCcw, Trash2 } from "lucide-react";
import { api, ApiError, resolveMediaUrl } from "../../api/client";
import { SauvegardeInventaire, SauvegardeJob, SauvegardeResume } from "../../api/types";
import { useToast } from "../../components/Toast";
import { formatBytes } from "../../lib/format";
import { ecritureAutorisee, essaiConcerne, nombreAnomalies, pourcentage } from "../../lib/sauvegardes";
import { authHeaders, erreurDetail, purgerSessionExpiree } from "./shared";

/** Deux modes de restauration, dans l'ordre où l'admin doit les rencontrer.
 *
 *  - `bucket` ne touche QUE le stockage : répare des fichiers perdus ou
 *    corrompus sans risque pour les lignes de base (un objet déjà présent est
 *    compté « déjà présent », jamais réécrit) ;
 *  - `disaster` rejoue aussi les métadonnées, avec leurs identifiants. Le
 *    serveur le REFUSE si la base contient déjà des épreuves, parce que
 *    recréer des lignes par-dessus un catalogue peuplé le corromprait.
 */
const MODES: { valeur: "bucket" | "disaster"; titre: string; explication: string }[] = [
  {
    valeur: "bucket",
    titre: "Recharge du stockage",
    explication:
      "Réécrit les fichiers manquants à leur clé d'origine. La base n'est pas touchée — c'est le mode à privilégier pour réparer un stockage dégradé.",
  },
  {
    valeur: "disaster",
    titre: "Restauration complète",
    explication:
      "Recrée les épreuves ET leurs fichiers, en préservant les identifiants. Réservé à une base vide : le serveur refuse si des épreuves existent déjà.",
  },
];

type Statut = "idle" | "chargement" | "pret" | "erreur";

/** État de la machine à deux temps de la restauration. L'écriture n'est
 *  proposée qu'après un ESSAI à blanc terminé sans anomalie, et seulement si
 *  l'admin coche une case de confirmation : le bouton d'écriture n'apparaît
 *  jamais avant.
 */
type Phase =
  | { etape: "repos" }
  | { etape: "essai"; job: SauvegardeJob }
  /** Essai TERMINÉ. Le job est conservé : c'est son rapport qui autorise (ou
   *  refuse) l'écriture suivante. Le perdre ici rendrait l'étape d'écriture
   *  inatteignable. */
  | { etape: "lecture"; job: SauvegardeJob };

function libelleStatut(status: string): string {
  if (status === "pending") return "En attente…";
  if (status === "running") return "En cours…";
  if (status === "done") return "Terminé";
  if (status === "error") return "Échec";
  return status;
}

/** Barre de progression + compteurs. `valeur` est déjà borné par
 *  `pourcentage` : la barre ne peut pas déborder. */
function Progression({ fait, total, libelle }: { fait: number; total: number; libelle: string }) {
  const pct = pourcentage(fait, total);
  return (
    <div>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={libelle}
        className="h-2 overflow-hidden rounded-full bg-ink-soft/15"
      >
        <div
          className="h-full rounded-full bg-ink transition-[width] motion-reduce:transition-none"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1 font-mono-tag text-[10px] text-slate">
        {pct} % — {fait.toLocaleString("fr-FR")} / {total.toLocaleString("fr-FR")} {libelle}
      </p>
    </div>
  );
}

/** Liste des anomalies d'un rapport. Une restauration qui a laissé un fichier
 *  de côté n'est PAS une restauration : l'écran doit nommer ce qui a été
 *  laissé, pas seulement dire « échec ». */
function Anomalies({ job }: { job: SauvegardeJob }) {
  const r = job.report;
  const introuvables = r.introuvables ?? [];
  const incoherences = r.incoherences ?? [];
  const corrompues = (r.corrompues ?? []).map((c) => `partie ${c.partie}`);
  const absents = r.absents ?? [];
  const erreurs = r.erreurs ?? [];
  // `nombreAnomalies` est LA source du décompte (testé dans
  // `lib/sauvegardes.test.ts`) ; la liste ci-dessous ne sert qu'à nommer les
  // fautifs. Le total est donc nécessairement identique au nombre affiché.
  const total = nombreAnomalies(r);
  if (total === 0) return null;
  return (
    <div className="mt-3 rounded-md border border-correction/30 bg-correction-soft p-3 text-sm text-correction">
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle size={15} strokeWidth={2} aria-hidden="true" />
        {total} anomalie{total > 1 ? "s" : ""} — la restauration n'est PAS complète
      </p>
      <ul className="mt-2 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
        {introuvables.map((c) => (
          <li key={`i-${c}`}>
            <code>{c}</code> — absent de la sauvegarde
          </li>
        ))}
        {incoherences.map((c, i) => (
          <li key={`h-${c.fichier}-${i}`}>
            <code>{c.fichier}</code> — empreinte {c.calcule.slice(0, 12)}… au lieu de{" "}
            {c.annonce.slice(0, 12)}…
          </li>
        ))}
        {corrompues.map((c) => (
          <li key={`c-${c}`}>
            <code>{c}</code> — archive corrompue
          </li>
        ))}
        {absents.map((a, i) => (
          <li key={`a-${a.storage_key}-${i}`}>
            {a.fichier ? <code>{a.fichier}</code> : null} — {a.erreur}
          </li>
        ))}
        {erreurs.map((e, i) => (
          <li key={`e-${i}`}>
            {e.fichier ? <code>{e.fichier}</code> : null}
            {e.partie ? <code>{e.partie}</code> : null} {e.erreur}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Onglet « Sauvegardes » : export manuel, inventaire des sauvegardes
 *  existantes, restauration en deux temps, suppression explicite.
 *
 *  Trois règles tenant la conception de l'écran :
 *
 *  1. **aucune écriture surprise**. Une restauration commence TOUJOURS par un
 *     essai à blanc ; le bouton d'écriture n'existe qu'après, et seulement si
 *     l'essai s'est terminé sans anomalie ;
 *  2. **aucune automatisation déguisée**. Pas de purge, pas de rétention, pas
 *     de planification : la suppression est un clic sur une sauvegarde nommée,
 *     avec son nom recopié dans la confirmation ;
 *  3. **la destination n'est pas choisie**. L'écran affiche la clé calculée
 *     par le serveur — il n'y a pas de champ « dossier de destination », et
 *     c'est volontaire (voir `PLAN_SAUVEGARDES.md`).
 */
export function SauvegardesPanel({ token }: { token: string }) {
  const { showToast } = useToast();
  const [inventaire, setInventaire] = useState<SauvegardeInventaire | null>(null);
  const [statut, setStatut] = useState<Statut>("chargement");
  const [selection, setSelection] = useState<string>("");
  const [mode, setMode] = useState<"bucket" | "disaster">("bucket");
  const [phase, setPhase] = useState<Phase>({ etape: "repos" });
  const [lu, setLu] = useState(false);
  const [aSupprimer, setASupprimer] = useState<string>("");
  const [exportEnCours, setExportEnCours] = useState(false);
  const refSuppression = useRef<HTMLDialogElement>(null);

  // La boîte de confirmation est un `<dialog>` monté en permanence et ouvert
  // par `showModal()` : c'est la seule façon d'obtenir le piège de focus et
  // l'inertie du fond sans les gérer à la main.
  useEffect(() => {
    const boite = refSuppression.current;
    if (!boite) return;
    if (aSupprimer && !boite.open) boite.showModal();
    else if (!aSupprimer && boite.open) boite.close();
  }, [aSupprimer]);

  const chargerInventaire = useCallback(async () => {
    setStatut("chargement");
    try {
      setInventaire(await api.get<SauvegardeInventaire>("/api/admin/sauvegardes", authHeaders(token)));
      setStatut("pret");
    } catch (err) {
      if (purgerSessionExpiree(err)) return;
      setStatut("erreur");
      showToast(erreurDetail(err, "Inventaire des sauvegardes illisible."), "error");
    }
  }, [token, showToast]);

  useEffect(() => {
    void chargerInventaire();
  }, [chargerInventaire]);

  // Suivi du job en cours : le même polling que l'import. La session peut
  // expirer entre le lancement et la fin (plusieurs minutes pour une
  // restauration) — un 401 doit donc être traité, pas avalé.
  //
  // Les DÉPENDANCES sont l'étape et l'id du job, jamais l'objet `phase` :
  // chaque réponse met à jour le statut, et un effet dépendant de l'objet
  // serait donc démonté/remonté à chaque tick — le minuteur ne finirait jamais
  // son tour et le suivi se figerait.
  const jobSuivi = phase.etape === "essai" ? phase.job.id : null;
  useEffect(() => {
    if (!jobSuivi) return;
    const timer = setInterval(async () => {
      try {
        const job = await api.get<SauvegardeJob>(
          `/api/admin/sauvegardes/jobs/${jobSuivi}`,
          authHeaders(token)
        );
        if (job.status === "done" || job.status === "error") {
          setPhase({ etape: "lecture", job });
          void chargerInventaire();
        } else {
          setPhase({ etape: "essai", job });
        }
      } catch (err) {
        if (purgerSessionExpiree(err)) return;
        /* retente au tick suivant */
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [jobSuivi, token, chargerInventaire]);

  async function creerSauvegarde() {
    setExportEnCours(true);
    try {
      const job = await api.post<SauvegardeJob>("/api/admin/sauvegardes/export", {}, authHeaders(token));
      setPhase({ etape: "essai", job });
      setLu(false);
      showToast("Sauvegarde en cours…", "success");
    } catch (err) {
      if (purgerSessionExpiree(err)) return;
      showToast(erreurDetail(err, "Export refusé."), "error");
    } finally {
      setExportEnCours(false);
    }
  }

  async function lancerEssai() {
    if (!selection) return;
    try {
      const job = await api.post<SauvegardeJob>(
        "/api/admin/sauvegardes/restore",
        { source: selection, mode, dry_run: true },
        authHeaders(token)
      );
      setPhase({ etape: "essai", job });
      setLu(false);
      showToast("Essai à blanc lancé — rien n'est écrit pour l'instant.", "info");
    } catch (err) {
      if (purgerSessionExpiree(err)) return;
      showToast(erreurDetail(err, "Essai à blanc refusé."), "error");
    }
  }

  async function ecrireReellement() {
    if (!selection || !lu) return;
    try {
      const job = await api.post<SauvegardeJob>(
        "/api/admin/sauvegardes/restore",
        { source: selection, mode, dry_run: false, confirme: true },
        authHeaders(token)
      );
      setPhase({ etape: "essai", job });
      setLu(false);
      showToast("Restauration lancée.", "success");
    } catch (err) {
      if (purgerSessionExpiree(err)) return;
      showToast(erreurDetail(err, "Restauration refusée."), "error");
    }
  }

  async function supprimer(cle: string) {
    try {
      await api.del(`/api/admin/sauvegardes/${cle}`, authHeaders(token));
      setASupprimer("");
      if (selection === cle) {
        setSelection("");
        setPhase({ etape: "repos" });
      }
      showToast("Sauvegarde supprimée.", "success");
      void chargerInventaire();
    } catch (err) {
      if (purgerSessionExpiree(err)) return;
      showToast(erreurDetail(err, "Suppression impossible."), "error");
    }
  }

  // Choisir une sauvegarde par sa FICHE doit avoir exactement l'effet du
  // menu déroulant : repartir de l'écran de choix. Sinon, après un essai
  // terminé sur A, cliquer « Restaurer celle-ci » sur B affiche B comme
  // sélectionnée tout en gardant le rapport de A à l'écran — et l'écran ne
  // montre plus aucun moyen de lancer l'essai de B, puisqu'il n'y a plus de
  // bloc de choix et qu'il faut changer deux fois de valeur pour que le
  // `<select>` émette un événement.
  function choisir(cle: string) {
    if (cle === selection) return;
    setSelection(cle);
    setLu(false);
    setPhase({ etape: "repos" });
  }

  const sauvegardes = inventaire?.sauvegardes ?? [];
  const choisie = sauvegardes.find((s) => s.cle === selection) ?? null;
  const enCours = phase.etape === "essai";
  const job = phase.etape === "repos" ? null : phase.job;
  const rapport = job?.report ?? null;
  const anomaliees = nombreAnomalies(rapport);
  // Règle de sécurité, testée dans `lib/sauvegardes.test.ts` : le bouton
  // d'écriture n'existe que si l'essai s'est terminé sans anomalie.
  const ecriturePossible = ecritureAutorisee(rapport, job?.status ?? "");
  // Un ESSAI de restauration terminé — et non un export, ni une écriture déjà
  // effectuée. Sans ce filtre, la carte « écrire pour de vrai » apparaîtrait
  // après chaque export, ce qui n'a aucun sens.
  const essaiTermine =
    phase.etape === "lecture" && job?.kind === "restore" && rapport?.dry_run === true;
  // Le bloc de confirmation ne vaut que pour la sauvegarde ESSAYÉE : en changer
  // invalide le rapport, donc l'accord.
  // Le bloc de confirmation ne vaut que pour CE QUE L'ESSAI A DÉCRIT : la même
  // sauvegarde ET le même mode. Comparer la seule sauvegarde suffisait pour que
  // changer de mode après coup laisse un rapport de `bucket` autorisant une
  // écriture `disaster` — dont les chiffres affichés n'étaient pas ceux de
  // l'opération qui allait partir.
  const accordVautPourEssai = essaiTermine && essaiConcerne(job, { source: selection, mode });

  // Changer de mode après un essai n'actualise pas le rapport : il l'invalide.
  // On revient donc à l'écran de choix, qui n'offre que de relancer un essai,
  // au lieu de laisser un accord floating sur un rapport qui ne parle plus de
  // l'opération.
  function changerMode(nouveau: "bucket" | "disaster") {
    if (nouveau === mode) return;
    setMode(nouveau);
    setLu(false);
    setPhase({ etape: "repos" });
  }

  function ficheResume(s: SauvegardeResume) {
    return (
      <li key={s.cle} className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono-tag text-xs">{s.nom}</p>
            <p className="mt-0.5 text-sm text-ink-soft">
              {s.epreuves} épreuve{s.epreuves > 1 ? "s" : ""} · {s.fichiers} fichier
              {s.fichiers > 1 ? "s" : ""} · {formatBytes(s.taille_octets)}
            </p>
            {s.modifie_le && (
              <p className="text-xs text-slate">
                {new Date(s.modifie_le).toLocaleString("fr-FR")} · {s.parties.length} partie
                {s.parties.length > 1 ? "s" : ""}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => choisir(s.cle)}
              aria-pressed={selection === s.cle}
              className={`min-h-[44px] rounded-full border px-4 text-sm ${
                selection === s.cle
                  ? "border-ink bg-ink text-paper"
                  : "border-ink-soft/25 hover:border-highlight/50"
              }`}
            >
              {selection === s.cle ? "Sélectionnée" : "Restaurer celle-ci"}
            </button>
            <button
              type="button"
              onClick={() => setASupprimer(s.cle)}
              aria-label={`Supprimer la sauvegarde ${s.nom}`}
              className="flex min-h-[44px] w-11 items-center justify-center rounded-full border border-correction/40 text-correction"
            >
              <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Pièces d'accompagnement : ce sont elles qui rendent la sauvegarde
            AUTONOME. Le manifeste seul suffit à savoir ce qu'on a, l'index à
            prouver que les parties sont intactes, et la procédure à savoir
            quoi en faire — sans avoir le dépôt sous la main. */}
        <ul className="mt-3 flex flex-wrap gap-2">
          {/* `resolveMediaUrl` et non un chemin nu : en développement le
              frontend est sur :5173 et l'API sur :8000. Un `href="/api/..."`
              irait chercher le backend sur le port du frontend et répondrait
              par l'index HTML — un téléchargement nommé `manifest.json` qui
              contient du HTML. En production (même origine) la fonction
              renvoie le chemin inchangé. */}
          {[
            ["LISEZMOI.txt", "Procédure de restauration"],
            ["manifest.json", "Inventaire complet"],
            ["index.json", "Empreintes des parties"],
          ].map(([fichier, libelle]) => (
            <li key={fichier}>
              <a
                href={resolveMediaUrl(
                  `/api/admin/sauvegardes/telecharger/${s.cle}/${fichier}`,
                )}
                className="flex min-h-[44px] items-center gap-1.5 rounded-full border border-ink-soft/25 px-3 text-xs hover:border-highlight/50"
              >
                <Download size={13} strokeWidth={1.75} aria-hidden="true" />
                {libelle}
              </a>
            </li>
          ))}
        </ul>

        <ul className="mt-3 space-y-1">
          {s.parties.map((p) => (
            <li key={p.nom} className="flex flex-wrap items-center gap-2 text-xs text-slate">
              <a
                href={resolveMediaUrl(
                  `/api/admin/sauvegardes/telecharger/${s.cle}/${encodeURIComponent(p.nom)}`,
                )}
                className="flex min-h-[44px] items-center gap-1.5 rounded-full border border-ink-soft/25 px-3 hover:border-highlight/50"
              >
                <Download size={13} strokeWidth={1.75} aria-hidden="true" />
                {p.nom}
              </a>
              <span>{formatBytes(p.octets)}</span>
              {/* L'empreinte EST la preuve d'intégrité : elle est affichée en
                  clair (tronquée) et copiable en entier via l'info-bulle. */}
              <span title={p.sha256 ?? "aucune empreinte"} className="font-mono-tag text-[10px]">
                sha256 {p.sha256 ? `${p.sha256.slice(0, 12)}…` : "—"}
              </span>
              <span>{p.nb_fichiers} fichier{p.nb_fichiers > 1 ? "s" : ""}</span>
            </li>
          ))}
        </ul>
      </li>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
        <h2 className="font-serif-brand text-lg">Sauvegardes</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Une sauvegarde contient le catalogue ENTIER : épreuves, sujets, corrigés, images et
          identifiants. Rien n'est filtré — une sauvegarde partielle semble rassurante et protège mal,
          puisqu'il faut alors se souvenir de ce qui n'y est pas.
        </p>
        <p className="mt-2 text-sm text-ink-soft">
          L'export est déclenché à la main. Il n'y a ni planification, ni rotation, ni purge
          automatique : une politique de rétention finit toujours par effacer la bonne sauvegarde au
          mauvais moment.
        </p>
        <button
          type="button"
          onClick={creerSauvegarde}
          disabled={exportEnCours || enCours}
          className="mt-4 flex min-h-[44px] items-center gap-2 rounded-full bg-ink px-5 text-sm text-paper disabled:opacity-50"
        >
          <HardDriveDownload size={16} strokeWidth={1.75} aria-hidden="true" />
          {exportEnCours ? "Lancement…" : "Créer une sauvegarde maintenant"}
        </button>
        {inventaire && (
          <p className="mt-2 text-xs text-slate">
            {sauvegardes.length} sauvegarde{sauvegardes.length > 1 ? "s" : ""} ·{" "}
            {formatBytes(inventaire.total_octets)} occupés
          </p>
        )}
      </div>

      <div>
        {job && (
          <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-serif-brand text-lg">
                Job <span className="font-mono-tag text-xs">{job.id.slice(0, 8)}</span> —{" "}
                {job.kind === "export" ? "export" : "restauration"}
              </h3>
              <span
                className={`rounded-full px-3 py-1 font-mono-tag text-[10px] ${
                  job.status === "done"
                    ? "bg-valide-soft text-valide"
                    : job.status === "error"
                    ? "bg-correction-soft text-correction"
                    : "bg-highlight-soft text-ink"
                }`}
              >
                {libelleStatut(job.status)}
              </span>
            </div>

            {job.destination && (
              <p className="mt-2 break-all font-mono-tag text-[10px] text-slate">
                {job.destination}
              </p>
            )}

            {/* Compteurs, pas journal : une barre qui n'avance que grâce à des
                lignes de log est une barre qu'on ne peut pas lire. */}
            {enCours && job.total_fichiers > 0 && (
              <div className="mt-3">
                <Progression fait={job.fichiers_faits} total={job.total_fichiers} libelle="fichiers" />
              </div>
            )}

            {rapport && (job.status === "done" || job.status === "error") && (
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                {/* Discrimination sur `job.kind`, JAMAIS sur la présence d'une
                    clé du rapport : « la clé existe-t-elle ? » est exactement le
                    test qui avait produit un export affiché « 0 fichier écrit »
                    alors que 12 fichiers venaient d'être écrits. `kind` est
                    posé par le serveur à la création du job, il ne bouge pas. */}
                {job.kind === "export" ? (
                  <>
                    <Compteur libelle="Fichiers écrits" valeur={String(rapport.nb_fichiers ?? 0)} />
                    <Compteur libelle="Octets" valeur={formatBytes(rapport.octets ?? 0)} />
                    <Compteur
                      libelle="Parties"
                      valeur={String((rapport.parties as unknown[] | undefined)?.length ?? 0)}
                    />
                    <Compteur
                      libelle="Absent du stockage"
                      valeur={String((rapport.absents as unknown[] | undefined)?.length ?? 0)}
                    />
                  </>
                ) : rapport.dry_run === true ? (
                  <>
                    <Compteur libelle="Épreuves" valeur={String(rapport.epreuves ?? 0)} />
                    <Compteur libelle="Fichiers annoncés" valeur={String(rapport.fichiers ?? 0)} />
                    <Compteur libelle="Serait écrit" valeur={String(rapport.ecrits ?? 0)} />
                    <Compteur libelle="Déjà présents" valeur={String(rapport.deja_presents ?? 0)} />
                  </>
                ) : (
                  <>
                    <Compteur libelle="Fichiers écrits" valeur={String(rapport.ecrits ?? 0)} />
                    <Compteur libelle="Déjà présents" valeur={String(rapport.deja_presents ?? 0)} />
                    <Compteur libelle="Épreuves" valeur={String(rapport.epreuves ?? 0)} />
                    <Compteur libelle="Octets" valeur={formatBytes(rapport.octets ?? 0)} />
                  </>
                )}
              </dl>
            )}

            {rapport && job.status === "done" && rapport.dry_run === true && (
              <p className="mt-3 rounded-md border border-valide/30 bg-valide-soft p-3 text-sm text-valide">
                Essai terminé : rien n'a été écrit. Les chiffres ci-dessus décrivent ce que la
                restauration<u> ferait</u>.
              </p>
            )}
            {job.status === "error" && (
              <p className="mt-3 rounded-md border border-correction/30 bg-correction-soft p-3 text-sm text-correction">
                Échec.{" "}
                {job.kind === "export" ? "La sauvegarde est incomplète" : "La restauration est incomplète"}{" "}
                — les détails ci-dessous nomment ce qui a été laissé de côté.
              </p>
            )}

            <Anomalies job={job} />
          </div>
        )}
      </div>

      {/* Deux temps : l'essai d'abord, l'écriture ensuite. Le bloc d'écriture
          n'est rendu QUE si l'essai s'est terminé sans anomalie, et la case de
          confirmation repart à zéro dès qu'on change de sauvegarde ou de mode. */}
      {phase.etape === "repos" && choisie && (
        <div className="rounded-lg border border-ink-soft/20 bg-paper-raised p-5">
          <h3 className="font-serif-brand text-lg">Restaurer {choisie.nom}</h3>
          <p className="mt-1 text-sm text-ink-soft">
            Choisis le mode, puis lance un <strong>essai à blanc</strong> : il vérifie
            l&apos;intégrité de la sauvegarde et dit ce qu&apos;il écrirait, sans rien écrire. L&apos;écriture
            réelle ne sera proposée qu&apos;ensuite.
          </p>
          <ChoisirMode mode={mode} onChange={changerMode} />
        </div>
      )}

      {accordVautPourEssai && choisie && (
        <div className="rounded-lg border border-ink-soft/20 bg-paper-raised p-5">
          <h3 className="font-serif-brand text-lg">Restaurer {choisie.nom}</h3>
            <p className="mt-1 text-sm text-ink-soft">
              Essai à blanc terminé. Change le mode si besoin : changer de mode
              annule cet accord, et imposera un nouvel essai.
            </p>
          <ChoisirMode mode={mode} onChange={changerMode} />

          {/* Dernière étape : l'écriture réelle, offerte seulement parce que
              `ecritureAutorisee` a validé l'essai. Elle exige en plus une case
              cochée — l'un sans l'autre ne suffirait pas. */}
          {ecriturePossible ? (
            <div className="mt-4 space-y-3 rounded-md border border-correction/30 bg-correction-soft p-3">
              <p className="flex items-center gap-2 text-sm font-medium text-correction">
                <RotateCcw size={15} strokeWidth={2} aria-hidden="true" />
                Dernière étape : écrire pour de vrai
              </p>
              <p className="text-xs text-correction">
                L&apos;essai à blanc s&apos;est terminé sans anomalie. L&apos;écriture n&apos;est possible
                qu&apos;avec ta confirmation explicite.
              </p>
              <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-correction">
                <input
                  type="checkbox"
                  checked={lu}
                  onChange={(e) => setLu(e.target.checked)}
                  className="h-4 w-4"
                />
                J&apos;ai lu le rapport d&apos;essai et je confirme l&apos;écriture
              </label>
              <button
                type="button"
                onClick={ecrireReellement}
                disabled={!lu}
                className="min-h-[44px] w-full rounded-full bg-correction px-4 text-sm text-paper disabled:opacity-50 sm:w-auto"
              >
                Restaurer {choisie.nom} ({formatBytes(rapport?.octets ?? 0)})
              </button>
            </div>
          ) : (
            <p className="mt-4 rounded-md border border-correction/30 bg-correction-soft p-3 text-sm text-correction">
              L&apos;essai a relevé {anomaliees} anomalie{anomaliees > 1 ? "s" : ""} : l&apos;écriture
              est bloquée tant qu&apos;elle n&apos;est pas corrigée. Corrige la sauvegarde, ou
              choisis-en une autre.
            </p>
          )}


          <button
            type="button"
            onClick={() => {
              setPhase({ etape: "repos" });
              setLu(false);
            }}
            className="mt-4 min-h-[44px] rounded-full border border-ink-soft/25 px-4 text-sm"
          >
            Fermer
          </button>
        </div>
      )}

      <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
        <h2 className="font-serif-brand text-lg">Inventaire</h2>
        {statut === "chargement" && (
          <p role="status" aria-live="polite" className="mt-2 text-sm text-ink-soft">
            Lecture des sauvegardes…
          </p>
        )}
        {statut === "erreur" && (
          <div className="mt-2">
            <p role="alert" className="text-sm text-correction">
              Inventaire illisible.
            </p>
            <button
              type="button"
              onClick={() => void chargerInventaire()}
              className="mt-2 min-h-[44px] rounded-full border border-ink-soft/25 px-4 text-sm"
            >
              Réessayer
            </button>
          </div>
        )}
        {statut === "pret" && sauvegardes.length === 0 && (
          <p className="mt-2 text-sm text-ink-soft">
            Aucune sauvegarde pour l&apos;instant. Crée la première ci-dessus.
          </p>
        )}
        {statut === "pret" && sauvegardes.length > 0 && (
          <>
              <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="sauvegarde-source" className="font-mono-tag text-[10px] text-ink-soft">
              Sauvegarde à restaurer
            </label>
            <select
              id="sauvegarde-source"
              value={selection}
              onChange={(e) => choisir(e.target.value)}
              className="min-h-[44px] rounded-[2px] border border-ink-soft/25 bg-paper px-2 text-sm"
            >
              <option value="">— choisir —</option>
              {sauvegardes.map((s) => (
                <option key={s.cle} value={s.cle}>
                  {s.nom} ({s.epreuves} épreuve{s.epreuves > 1 ? "s" : ""},{" "}
                  {formatBytes(s.taille_octets)})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={lancerEssai}
              disabled={!selection || enCours}
              className="min-h-[44px] rounded-full border border-ink-soft/25 px-4 text-sm disabled:opacity-50"
            >
              Lancer un essai à blanc
            </button>
          </div>
            <ul className="mt-4 space-y-3">{sauvegardes.map(ficheResume)}</ul>
          </>
        )}
      </div>

      {/* Confirmation de suppression. Implémentée en `<dialog>` NATIF
          (`showModal`) plutôt qu'en div : le piège de focus, l'inertie du fond
          et la fermeture par Échap sont fournis par le navigateur, donc
          impossibles à oublier. Un `role="dialog"` sur un div n'offre aucun de
          ces trois garanties. La clé `onKeyDown` ne porte QUE sur Échap : une
          écoute globale `keydown` se déclencherait aussi sur les raccourcis
          du panneau (flèches des onglets admin, par exemple) et refermerait
          la boîte au mauvais moment. */}
      <dialog
        ref={refSuppression}
        onKeyDown={(e) => {
          if (e.key === "Escape") setASupprimer("");
        }}
        onClose={() => setASupprimer("")}
        aria-labelledby="supprimer-titre"
        className="m-auto w-full max-w-md space-y-4 rounded-lg border border-ink-soft/20 bg-paper-raised p-5 backdrop:bg-ink/40"
      >
        <h3 id="supprimer-titre" className="font-serif-brand text-lg">
          Supprimer cette sauvegarde ?
        </h3>
        <p className="text-sm text-ink-soft">
          <code className="break-all">{aSupprimer}</code> et toutes ses parties seront
              définitivement supprimées du stockage. Cette action est irréversible.
            </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setASupprimer("")}
            className="min-h-[44px] rounded-full border border-ink-soft/25 px-4 text-sm"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={() => void supprimer(aSupprimer)}
            className="min-h-[44px] rounded-full bg-correction px-4 text-sm text-paper"
          >
            Supprimer définitivement
          </button>
        </div>
      </dialog>
    </div>
  );
}

/** Sélecteur de mode, `fieldset` + `legend` pour que les deux options soient
 *  annoncées comme un groupe de boutons radio (et pas comme deux cases
 *  isolées). Le changement de mode remet l'accord à zéro côté appelant. */
function ChoisirMode({
  mode,
  onChange,
}: {
  mode: "bucket" | "disaster";
  onChange: (m: "bucket" | "disaster") => void;
}) {
  return (
    <fieldset className="mt-3 space-y-2">
      <legend className="font-mono-tag text-[10px] text-ink-soft">Mode de restauration</legend>
      {MODES.map((m) => (
        <label key={m.valeur} className="flex min-h-[44px] cursor-pointer items-start gap-2">
          <input
            type="radio"
            name="mode-restauration"
            value={m.valeur}
            checked={mode === m.valeur}
            onChange={() => onChange(m.valeur)}
            className="mt-1"
          />
          <span>
            <span className="text-sm font-medium">{m.titre}</span>
            <span className="block text-xs text-ink-soft">{m.explication}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function Compteur({ libelle, valeur }: { libelle: string; valeur: string }) {
  return (
    <div>
      <dt className="font-mono-tag text-[10px] text-slate">{libelle}</dt>
      <dd className="font-serif-brand text-lg">{valeur}</dd>
    </div>
  );
}
