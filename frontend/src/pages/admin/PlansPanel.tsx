import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { authHeaders, purgerSessionExpiree } from "./shared";

interface Plan {
  id: string;
  scope: string;
  libelle: string;
  libelle_en: string;
  description: string;
  description_en: string;
  prix: number;
  duree_jours: number;
  actif: boolean;
  ordre: number;
}
interface Liste {
  plans: Plan[];
  scopes: Record<string, string>;
}

const champ = "w-full rounded border border-ink-soft/30 bg-paper px-2 py-1.5 text-sm";

/** Onglet « Formules » : créer, modifier et supprimer les formules d'abonnement.
 * Supprimer une formule n'affecte pas les abonnements déjà vendus. */
export function PlansPanel({ token }: { token: string }) {
  const { showToast } = useToast();
  const [data, setData] = useState<Liste | null>(null);
  const [edition, setEdition] = useState<Record<string, Partial<Plan>>>({});
  const [aSupprimer, setASupprimer] = useState<Plan | null>(null);

  const load = useCallback(() => {
    api
      .get<Liste>("/api/admin/plans", authHeaders(token))
      .then((d) => {
        setData(d);
        setEdition({});
      })
      .catch((e) => {
        if (!purgerSessionExpiree(e)) showToast("Chargement des formules impossible.", "error");
      });
  }, [token, showToast]);
  useEffect(load, [load]);

  const erreur = () => showToast("L'opération a échoué — vérifie les valeurs (prix ≥ 100 FCFA).", "error");
  const modifier = (p: Plan, patch: Partial<Plan>) =>
    setEdition((e) => ({ ...e, [p.id]: { ...e[p.id], ...patch } }));
  const enregistrer = (p: Plan) =>
    void api
      .patch(`/api/admin/plans/${p.id}`, edition[p.id] ?? {}, authHeaders(token))
      .then(() => {
        showToast("Formule enregistrée.", "success");
        load();
      })
      .catch(erreur);
  const creer = (scope: string) =>
    void api
      .post("/api/admin/plans", { scope, libelle: data?.scopes[scope] ?? scope, prix: 1000, duree_jours: 365, actif: false }, authHeaders(token))
      .then(load)
      .catch(erreur);
  const supprimer = () => {
    if (!aSupprimer) return;
    void api
      .del(`/api/admin/plans/${aSupprimer.id}`, authHeaders(token))
      .then(() => {
        setASupprimer(null);
        load();
      })
      .catch(erreur);
  };

  if (!data) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft">
        Les formules actives sont proposées sur la page Abonnement. Une nouvelle formule est créée désactivée : complète-la puis active-la.
      </p>
      {data.plans.map((p) => {
        const v = { ...p, ...edition[p.id] };
        const modifie = Boolean(edition[p.id]);
        return (
          <div key={p.id} className="space-y-2 rounded-lg border border-ink-soft/20 bg-paper-raised p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono-tag text-xs text-slate">{data.scopes[p.scope] ?? p.scope}</span>
              <label className="ml-auto flex items-center gap-2 text-sm">
                <input type="checkbox" checked={v.actif} onChange={(e) => modifier(p, { actif: e.target.checked })} /> Active
              </label>
              <button aria-label={`Supprimer ${p.libelle}`} onClick={() => setASupprimer(p)} className="min-h-[44px] min-w-[44px] text-correction">
                <Trash2 size={16} className="mx-auto" />
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <input aria-label="Libellé (FR)" className={champ} value={v.libelle} onChange={(e) => modifier(p, { libelle: e.target.value })} />
              <input aria-label="Libellé (EN)" placeholder="Label (EN)" className={champ} value={v.libelle_en} onChange={(e) => modifier(p, { libelle_en: e.target.value })} />
              <input aria-label="Description (FR)" className={champ} value={v.description} onChange={(e) => modifier(p, { description: e.target.value })} />
              <input aria-label="Description (EN)" placeholder="Description (EN)" className={champ} value={v.description_en} onChange={(e) => modifier(p, { description_en: e.target.value })} />
              <label className="text-xs text-slate">
                Prix (FCFA)
                <input type="number" min={100} className={champ} value={v.prix} onChange={(e) => modifier(p, { prix: Number(e.target.value) })} />
              </label>
              <label className="text-xs text-slate">
                Durée (jours)
                <input type="number" min={1} className={champ} value={v.duree_jours} onChange={(e) => modifier(p, { duree_jours: Number(e.target.value) })} />
              </label>
            </div>
            {modifie && (
              <button onClick={() => enregistrer(p)} className="min-h-[44px] rounded-full bg-ink px-4 text-sm text-paper">
                Enregistrer
              </button>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Plus size={16} aria-hidden />
        {Object.entries(data.scopes).map(([scope, label]) => (
          <button key={scope} onClick={() => creer(scope)} className="min-h-[44px] rounded-full border border-ink-soft/30 px-3 text-sm">
            {label}
          </button>
        ))}
      </div>
      {aSupprimer && (
        <ConfirmDialog
          tone="danger"
          title={`Supprimer « ${aSupprimer.libelle} » ?`}
          message="Les abonnements déjà vendus avec cette formule ne sont pas modifiés."
          onConfirm={supprimer}
          onClose={() => setASupprimer(null)}
        />
      )}
    </div>
  );
}
