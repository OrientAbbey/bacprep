import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AdminStats } from "../../api/types";
import { formatBytes } from "../../lib/format";
import { classeLabel } from "../../lib/referentiel";

/** Tableau de bord du back-office : compteurs globaux + graphiques recharts
 * pour les revenus mensuels et les épreuves publiées par classe. Le donut
 * de stockage reste en SVG maison (cas à 2 segments, inchangé). */
export function StatsPanel({ stats }: { stats: AdminStats }) {
  const revenus = Object.entries(stats.revenus_par_mois ?? {}).map(([k, v]) => ({
    mois: k,
    montant: v,
  }));
  const parClasse = Object.entries(stats.epreuves_par_classe ?? {}).map(([k, v]) => ({
    classe: classeLabel(k),
    nombre: v,
  }));
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
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
          <p className="mb-2 font-mono-tag text-[10px] text-slate">ÉPREUVES PUBLIÉES PAR CLASSE</p>
          <EpreuvesParClasseChart data={parClasse} />
        </div>
        <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
          <p className="mb-2 font-mono-tag text-[10px] text-slate">REVENUS CONFIRMÉS (FCFA)</p>
          <RevenusMensuelsChart data={revenus} />
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

/** Barres verticales des 6 derniers mois (recharts) — étiquette AAAA-MM en
 * abscisse, tooltip formaté fr-FR. Couleurs via les variables du thème. */
function RevenusMensuelsChart({ data }: { data: { mois: string; montant: number }[] }) {
  if (data.length === 0) return <p className="text-xs text-slate">Aucune donnée.</p>;
  return (
    <ResponsiveContainer width="100%" height={150}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-ink-soft)" opacity={0.15} vertical={false} />
        <XAxis dataKey="mois" tick={{ fontSize: 10 }} stroke="var(--color-ink-soft)" />
        <YAxis tick={{ fontSize: 10 }} stroke="var(--color-ink-soft)" />
        <Tooltip
          formatter={(value) => [`${Number(value).toLocaleString("fr-FR")} FCFA`, "Revenus"]}
          contentStyle={{ fontSize: 12 }}
        />
        <Bar dataKey="montant" fill="var(--color-highlight)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Barres horizontales (recharts, layout vertical) — une barre par classe,
 * la plus longue à gauche (tri descendant), tooltip nombre d'épreuves. */
function EpreuvesParClasseChart({ data }: { data: { classe: string; nombre: number }[] }) {
  if (data.length === 0) return <p className="text-xs text-slate">Aucune donnée.</p>;
  const triees = [...data].sort((a, b) => b.nombre - a.nombre);
  return (
    <ResponsiveContainer width="100%" height={150}>
      <BarChart data={triees} layout="vertical" margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-ink-soft)" opacity={0.15} horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 10 }} stroke="var(--color-ink-soft)" allowDecimals={false} />
        <YAxis type="category" dataKey="classe" tick={{ fontSize: 11 }} stroke="var(--color-ink-soft)" width={64} />
        <Tooltip formatter={(value) => [`${value} épreuve(s)`, "Publiées"]} contentStyle={{ fontSize: 12 }} />
        <Bar dataKey="nombre" fill="var(--color-highlight)" radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Anneau SVG maison : répartition du stockage documents vs images. */
function StorageDonut({ md, image }: { md: number; image: number }) {
  const total = md + image;
  if (total === 0) return <p className="text-xs text-slate">Aucun fichier stocké.</p>;
  // Circonférence du cercle de rayon 30 : 2πr ≈ 188.5
  const C = 2 * Math.PI * 30;
  const mdRatio = md / total;
  return (
    <div className="flex items-center gap-4">
      <svg width="72" height="72" viewBox="0 0 72 72" role="img" aria-label="Répartition du stockage">
        <circle cx="36" cy="36" r="30" fill="none" stroke="var(--color-ink-soft)" strokeWidth="10" opacity="0.25" />
        <circle
          cx="36"
          cy="36"
          r="30"
          fill="none"
          stroke="var(--color-highlight)"
          strokeWidth="10"
          strokeDasharray={`${C * mdRatio} ${C}`}
          transform="rotate(-90 36 36)"
        />
        <circle
          cx="36"
          cy="36"
          r="30"
          fill="none"
          stroke="var(--color-valide)"
          strokeWidth="10"
          strokeDasharray={`${C * (1 - mdRatio)} ${C}`}
          strokeDashoffset={-C * mdRatio}
          transform="rotate(-90 36 36)"
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