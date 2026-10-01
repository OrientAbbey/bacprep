import { useEffect, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { api, ApiError } from "../../api/client";
import { ImportJob } from "../../api/types";
import { useToast } from "../../components/Toast";
import { Stat } from "./StatsPanel";
import { authHeaders } from "./shared";

/** Zone d'import massif : upload d'un dossier compressé (.zip) organisé
 * {annee}/{classe}/{matiere}/*.md, traitement en tâche de fond par le même
 * moteur que le script CLI `python -m app.scripts.importer`, puis rapport
 * détaillé (créées, doublons, métadonnées manquantes, erreurs). */
export function ImportPanel({ token }: { token: string }) {
  const { showToast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const logsRef = useRef<HTMLPreElement>(null);

  // Défilement automatique de la console de logs vers la dernière ligne
  // tant que le job est en cours.
  useEffect(() => {
    if (job?.status === "pending" || job?.status === "running") {
      logsRef.current?.scrollTo({ top: logsRef.current.scrollHeight });
    }
  }, [job?.logs?.length, job?.status]);

  async function loadJobs() {
    try {
      const list = await api.get<ImportJob[]>("/api/admin/import/jobs", authHeaders(token));
      setJobs(list);
    } catch {
      /* silencieux : la liste est un confort, pas un besoin critique */
    }
  }

  useEffect(() => {
    loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling du job en cours tant qu'il n'est pas terminé.
  useEffect(() => {
    if (!job || job.status === "done" || job.status === "error") return;
    const timer = setInterval(async () => {
      try {
        const fresh = await api.get<ImportJob>(`/api/admin/import/jobs/${job.id}`, authHeaders(token));
        setJob(fresh);
        if (fresh.status === "done" || fresh.status === "error") loadJobs();
      } catch {
        /* retente au prochain tick */
      }
    }, 1500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  async function startImport() {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api.upload<{ job_id: string }>("/api/admin/import", fd, authHeaders(token));
      setJob({
        id: res.job_id,
        filename: file.name,
        status: "pending",
        created_at: new Date().toISOString(),
        finished_at: null,
        report: {},
        logs: [],
      });
      showToast("Import lancé — traitement en cours.", "success");
    } catch (err) {
      if (err instanceof ApiError) showToast(`Import refusé : ${JSON.stringify(err.detail)}`, "error");
      else showToast("Échec de l'envoi de l'archive.", "error");
    } finally {
      setUploading(false);
    }
  }

  const report = job?.report;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
        <h2 className="font-serif-brand text-lg">Importer un dossier d'épreuves</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Compresse un dossier organisé puis dépose l'archive. Structure attendue (tolérante) :
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-paper p-3 font-mono text-xs text-ink-soft">
{`mon-dossier/
└── 2023/
    └── Terminale/
        └── Mathématiques/
            ├── bac-D-sujet.md
            ├── bac-D-corrige.md
            └── figure1.png`}
        </pre>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-ink-soft">
          <li>Uniquement des fichiers Markdown (<code>.md</code>) et des images — pas de PDF.</li>
          <li>
            Nom de fichier contenant <code>corrige</code> → corrigé, sinon sujet. La série est extraite
            du nom (<code>série D</code>, <code>bac-D</code>…).
          </li>
          <li>
            Les doublons (contenu identique) sont détectés par empreinte SHA-256 et ignorés ; les
            fichiers dont les métadonnées (année/classe/matière) sont insuffisantes sont signalés.
          </li>
          <li>Les épreuves importées arrivent en <strong>brouillon</strong> : à relire puis publier.</li>
          <li>
            Alternative en ligne de commande sur le serveur :{" "}
            <code>python -m app.scripts.importer --dir backend/data/imports</code>.
          </li>
        </ul>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="cursor-pointer">
            <span className="flex min-h-[40px] items-center gap-2 rounded-full border border-ink-soft/25 px-4 text-sm hover:border-highlight/50">
              <FileUp size={16} strokeWidth={1.75} aria-hidden="true" />
              {file ? file.name : "Choisir une archive .zip…"}
            </span>
            <input
              type="file"
              accept=".zip"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <button
            onClick={startImport}
            disabled={!file || uploading}
            className="min-h-[44px] rounded-full bg-ink px-5 text-sm text-paper disabled:opacity-50"
          >
            {uploading ? "Envoi…" : "Lancer l'import"}
          </button>
        </div>
      </div>

      {job && (
        <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
          <div className="flex items-center justify-between">
            <h3 className="font-serif-brand text-lg">
              Job <span className="font-mono-tag text-xs">{job.id.slice(0, 8)}</span> — {job.filename}
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
              {job.status === "pending" && "En attente…"}
              {job.status === "running" && "Traitement en cours…"}
              {job.status === "done" && "Terminé"}
              {job.status === "error" && "Erreur"}
            </span>
          </div>

          {report && (job.status === "done" || job.status === "error") && (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Fichiers analysés" value={String(report.analyses ?? 0)} />
              <Stat label="Épreuves créées" value={String(report.epreuves_creees ?? 0)} />
              <Stat label="Images importées" value={String(report.images_importees ?? 0)} />
              <Stat label="Doublons ignorés" value={String(report.doublons?.length ?? 0)} />
            </div>
          )}

          {/* Console de journal en direct : lignes accumulées par la tâche
              de fond (polling 1,5 s), affichées pendant l'exécution ET
              conservées après la fin pour relecture. Défilement auto vers
              la dernière ligne tant que le job tourne. */}
          {job.logs && job.logs.length > 0 && (
            <pre
              ref={logsRef}
              className="mt-4 max-h-48 overflow-y-auto rounded-lg bg-margin p-3 font-mono text-xs leading-relaxed text-margin-text"
              aria-label="Journal d'exécution de l'import"
            >
              {job.logs.map((ligne, i) => (
                <span key={i} className={ligne.startsWith("ERREUR") ? "text-correction" : undefined}>
                  {ligne}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}

          {report?.metadonnees_manquantes && report.metadonnees_manquantes.length > 0 && (
            <div className="mt-4">
              <p className="font-mono-tag text-[10px] text-correction">MÉTADONNÉES INSUFFISANTES</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-ink-soft">
                {report.metadonnees_manquantes.map((m, i) => (
                  <li key={i}>
                    <code>{m.fichier}</code> — manquant : {m.manquants.join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report?.erreurs && report.erreurs.length > 0 && (
            <div className="mt-4">
              <p className="font-mono-tag text-[10px] text-correction">ERREURS</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-ink-soft">
                {report.erreurs.map((e, i) => (
                  <li key={i}>
                    <code>{e.fichier}</code> — {e.erreur}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report?.references_non_reecrites && report.references_non_reecrites.length > 0 && (
            <div className="mt-4">
              <p className="font-mono-tag text-[10px] text-correction">
                RÉFÉRENCES D&apos;IMAGES NON RÉÉCRITES
              </p>
              <p className="mt-1 text-xs text-ink-soft">
                Ces images resteront cassées à l&apos;affichage : le lien pointe encore vers un
                nom de fichier local au lieu de l&apos;URL contrôlée.
              </p>
              <ul className="mt-1 list-disc pl-5 text-xs text-ink-soft">
                {report.references_non_reecrites.map((r, i) => (
                  <li key={i}>
                    <code>{r.fichier}</code> — {r.image} ({r.nb} référence(s), {r.document})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report?.contenus_partages && report.contenus_partages.length > 0 && (
            <div className="mt-4">
              <p className="font-mono-tag text-[10px] text-slate">CONTENUS PARTAGÉS</p>
              <p className="mt-1 text-xs text-ink-soft">
                Ces fichiers ont été importés malgré des octets identiques déjà présents dans une
                autre épreuve (logo commun, consignes réutilisées) — ce n&apos;est pas une erreur.
              </p>
              <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5 text-xs text-ink-soft">
                {report.contenus_partages.map((c, i) => (
                  <li key={i}>
                    <code>{c.fichier}</code> — identique dans {c.deja_dans.length} autre(s) épreuve(s)
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report?.creees && report.creees.length > 0 && (
            <div className="mt-4">
              <p className="font-mono-tag text-[10px] text-ink-soft">FICHIERS IMPORTÉS</p>
              <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5 text-xs text-ink-soft">
                {report.creees.map((c, i) => (
                  <li key={i}>
                    <code>{c.fichier}</code>
                    {c.epreuve_id ? ` → épreuve ${c.epreuve_id} (${c.cible})` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {jobs.length > 0 && (
        <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
          <h3 className="font-serif-brand text-lg">Imports précédents</h3>
          <ul className="mt-2 divide-y divide-ink-soft/10 text-sm">
            {jobs.map((j) => (
              <li key={j.id} className="flex items-center justify-between py-2">
                <span>
                  {j.filename || j.id.slice(0, 8)}{" "}
                  <span className="font-mono-tag text-[10px] text-slate">
                    {new Date(j.created_at).toLocaleString("fr-FR")}
                  </span>
                </span>
                <span
                  className={`font-mono-tag text-[10px] ${
                    j.status === "done" ? "text-valide" : j.status === "error" ? "text-correction" : "text-slate"
                  }`}
                >
                  {j.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}