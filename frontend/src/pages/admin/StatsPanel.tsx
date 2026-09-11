import { AdminStats } from "../../api/types";
import { formatBytes } from "../../lib/format";
import { classeLabel } from "../../lib/referentiel";

/** Tableau de bord du back-office : compteurs globaux + graphiques maison
 * (aucune dépendance). */
export function StatsPanel({ stats }: { stats: AdminStats }) {
  return (
    <div className="space-y-3">
      <h2 className="font-serif-brand text-lg">Statistiques</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Utilisateurs" value={String(stats.utilisateurs)} />
        <Stat label="Abonnements actifs" value={String(stats.abonnements_actifs)} />
        <Stat label="Revenu (FCFA)" value={String(stats.revenu_total_fcfa)} />
        <Stat label="Épreuves publiées" value={String(stats.epreuves_par_statut?.publie ?? 0)} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Consultations" value={String(stats.consultations)} />
        <Stat label="Notes" value={String(stats.notes)} />
        <Stat label="Discussions IA" value={String(stats.discussions_ia)} />
        <Stat
          label="Stockage objet"
          value={formatBytes(stats.stockage?.total_octets ?? 0)}
          sub={`${stats.stockage?.nb_fichiers ?? 0} fichiers`}
        />
      </div>
      {/* Graphiques maison (aucune dépendance) : épreuves publiées par
          classe, revenus confirmés par mois, répartition du stockage. */}
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
          <p className="mb-2 font-mono-tag text-[10px] text-slate">ÉPREUVES PUBLIÉES PAR CLASSE</p>
          <BarList
            data={Object.entries(stats.epreuves_par_classe ?? {}).map(([k, v]) => ({
              label: classeLabel(k),
              value: v,
            }))}
          />
        </div>
        <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
          <p className="mb-2 font-mono-tag text-[10px] text-slate">REVENUS CONFIRMÉS (FCFA)</p>
          <BarList
            data={Object.entries(stats.revenus_par_mois ?? {}).map(([k, v]) => ({
              label: k,
              value: v,
            }))}
            formatValue={(v) => v.toLocaleString("fr-FR")}
          />
        </div>
        <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
          <p className="mb-2 font-mono-tag text-[10px] text-slate">RÉPARTITION DU STOCKAGE</p>
          <StorageDonut
            md={stats.stockage?.par_format?.md ?? 0}
            image={stats.stockage?.par_format?.image ?? 0}
          />
        </div>
      </div>
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-3">
      <p className="font-mono-tag text-[10px] text-slate">{label}</p>
      <p className="font-serif-brand text-xl">{value}</p>
      {sub && <p className="text-xs text-slate">{sub}</p>}
    </div>
  );
}

/** Barres horizontales maison (aucune dépendance) — largeur proportionnelle
 *  à la valeur, étiquette + valeur alignées. */
function BarList({
  data,
  formatValue = String,
}: {
  data: { label: string; value: number }[];
  formatValue?: (v: number) => string;
}) {
  if (data.length === 0) return <p className="text-xs text-slate">Aucune donnée.</p>;
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="space-y-1.5">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 truncate text-ink-soft" title={d.label}>
            {d.label}
          </span>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-highlight-soft/50">
            <div
              className="h-full rounded-full bg-highlight"
              style={{ width: `${Math.max((d.value / max) * 100, 2)}%` }}
            />
          </div>
          <span className="w-16 shrink-0 text-right font-mono-tag text-[10px] text-ink-soft">
            {formatValue(d.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Anneau SVG maison : répartition du stockage documents vs images. */
function StorageDonut({ md, image }: { md: number; image: number }) {
  const total = md + image;
  if (total === 0) return <p className="text-xs text-slate">Aucun fichier stocké.</p>;
  // Circonférence du cercle de rayon 40 : 2πr ≈ 251.2
  const C = 2 * Math.PI * 40;
  const mdRatio = md / total;
  return (
    <div className="flex items-center gap-4">
      <svg width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="Répartition du stockage">
        <circle cx="48" cy="48" r="40" fill="none" stroke="var(--color-ink-soft)" strokeWidth="12" opacity="0.25" />
        <circle
          cx="48"
          cy="48"
          r="40"
          fill="none"
          stroke="var(--color-highlight)"
          strokeWidth="12"
          strokeDasharray={`${C * mdRatio} ${C}`}
          transform="rotate(-90 48 48)"
        />
        <circle
          cx="48"
          cy="48"
          r="40"
          fill="none"
          stroke="var(--color-valide)"
          strokeWidth="12"
          strokeDasharray={`${C * (1 - mdRatio)} ${C}`}
          strokeDashoffset={-C * mdRatio}
          transform="rotate(-90 48 48)"
        />
      </svg>
      <div className="space-y-1 text-xs">
        <p className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-highlight" aria-hidden="true" />
          Documents — {formatBytes(md)}
        </p>
        <p className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-valide" aria-hidden="true" />
          Images — {formatBytes(image)}
        </p>
        <p className="text-slate">Total : {formatBytes(total)}</p>
      </div>
    </div>
  );
}