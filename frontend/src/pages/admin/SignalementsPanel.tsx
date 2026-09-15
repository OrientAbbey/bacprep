import { useEffect, useState } from "react";
import { Flag } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { Signalement } from "../../api/types";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { MOTIF_LABELS } from "../../lib/motifs";
import { classeLabel } from "../../lib/referentiel";
import { formatRelativeTime } from "../../lib/time";
import { authHeaders, purgerSessionExpiree } from "./shared";

/** Signalements d'épreuves : liste avec auteur, motif, message, et action
 *  « marquer résolu ». */
export function SignalementsPanel({ token }: { token: string }) {
  const { showToast } = useToast();
  const [signalements, setSignalements] = useState<Signalement[] | null>(null);
  const [erreur, setErreur] = useState(false);

  function load() {
    setErreur(false);
    api
      .get<Signalement[]>("/api/admin/signalements", authHeaders(token))
      .then(setSignalements)
      .catch((err) => {
        if (!purgerSessionExpiree(err)) setErreur(true);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function resoudre(id: string) {
    try {
      await api.post(`/api/admin/signalements/${id}/resoudre`, undefined, authHeaders(token));
      showToast("Signalement marqué résolu.", "success");
      load();
    } catch {
      showToast("Échec de la mise à jour du signalement.", "error");
    }
  }

  if (erreur)
    return (
      <div
        role="alert"
        className="rounded-lg border border-correction/30 bg-correction-soft p-5 text-sm text-correction"
      >
        <p>Les signalements n'ont pas pu être chargés.</p>
        <button type="button" onClick={load} className="mt-2 underline">
          Réessayer
        </button>
      </div>
    );
  if (!signalements)
    return (
      <div className="space-y-2 rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className={`h-4 ${i % 2 === 0 ? "w-full" : "w-2/3"}`} />
        ))}
      </div>
    );
  if (signalements.length === 0)
    return (
      <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5 text-sm text-slate">
        Aucun signalement — rien à traiter pour l'instant.
      </div>
    );

  return (
    <div className="space-y-3">
      <h2 className="sr-only">Signalements</h2>
      {signalements.map((s) => (
        <div
          key={s.id}
          className={`rounded-lg border bg-paper-raised p-4 ${
            s.statut === "ouvert" ? "border-correction/30" : "border-ink-soft/15 opacity-70"
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Flag size={15} strokeWidth={1.75} aria-hidden="true" className={s.statut === "ouvert" ? "text-correction" : "text-slate"} />
            <p className="font-medium">
              {MOTIF_LABELS[s.motif] ?? s.motif} — {s.matiere} {s.annee} ({classeLabel(s.classe)})
            </p>
            <span
              className={`ml-auto rounded-full px-2.5 py-0.5 font-mono-tag text-[10px] ${
                s.statut === "ouvert" ? "bg-correction-soft text-correction" : "bg-valide-soft text-valide"
              }`}
            >
              {s.statut === "ouvert" ? "Ouvert" : "Résolu"}
            </span>
          </div>
          {s.message && <p className="mt-2 text-sm text-ink-soft">« {s.message} »</p>}
          <p className="mt-2 font-mono-tag text-[10px] text-slate">
            {s.auteur_email} · {formatRelativeTime(s.created_at)} ·{" "}
            <Link to={`/epreuve/${s.epreuve_id}`} className="underline hover:text-ink">
              ouvrir l'épreuve
            </Link>
          </p>
          {s.statut === "ouvert" && (
            <button
              type="button"
              onClick={() => resoudre(s.id)}
              className="mt-3 min-h-[44px] rounded-full border border-valide/40 px-4 text-xs font-medium text-valide hover:bg-valide-soft/40"
            >
              Marquer résolu
            </button>
          )}
        </div>
      ))}
    </div>
  );
}