import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { api } from "../../api/client";
import type { Evenement } from "../../api/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { authHeaders, purgerSessionExpiree } from "./shared";

const champ = "w-full rounded border border-ink-soft/30 bg-paper px-2 py-1.5 text-sm";
const VIDE = { titre: "", type: "examen", evaluation: "", date_debut: "", date_fin: "", lien_officiel: "", visible: true };

/** Onglet « Calendrier » : dates officielles d'examens, de résultats et d'inscriptions. */
export function CalendrierPanel({ token }: { token: string }) {
  const { showToast } = useToast();
  const [liste, setListe] = useState<Evenement[] | null>(null);
  const [form, setForm] = useState<Record<string, string | boolean>>(VIDE);
  const [aSupprimer, setASupprimer] = useState<Evenement | null>(null);

  const load = useCallback(() => {
    api
      .get<Evenement[]>("/api/admin/evenements", authHeaders(token))
      .then(setListe)
      .catch((e) => {
        if (!purgerSessionExpiree(e)) showToast("Chargement du calendrier impossible.", "error");
      });
  }, [token, showToast]);
  useEffect(load, [load]);

  const erreur = () => showToast("Échec : titre et date de début (AAAA-MM-JJ) obligatoires, lien en https://.", "error");
  const creer = () =>
    void api
      .post("/api/admin/evenements", form, authHeaders(token))
      .then(() => {
        setForm(VIDE);
        showToast("Événement ajouté.", "success");
        load();
      })
      .catch(erreur);
  const basculer = (e: Evenement) =>
    void api.patch(`/api/admin/evenements/${e.id}`, { visible: !e.visible }, authHeaders(token)).then(load).catch(erreur);
  const supprimer = () => {
    if (!aSupprimer) return;
    void api
      .del(`/api/admin/evenements/${aSupprimer.id}`, authHeaders(token))
      .then(() => {
        setASupprimer(null);
        load();
      })
      .catch(erreur);
  };
  const set = (k: string, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft">Saisis les dates officielles : elles alimentent la page Calendrier et le compte à rebours de l'accueil.</p>
      <div className="grid gap-2 rounded-lg border border-ink-soft/20 bg-paper-raised p-4 sm:grid-cols-2">
        <input aria-label="Titre" placeholder="Titre (ex. Probatoire — session 2027)" className={champ} value={form.titre as string} onChange={(e) => set("titre", e.target.value)} />
        <select aria-label="Type" className={champ} value={form.type as string} onChange={(e) => set("type", e.target.value)}>
          <option value="examen">Examen</option>
          <option value="resultats">Résultats</option>
          <option value="inscription">Inscription</option>
        </select>
        <input aria-label="Évaluation" placeholder="Évaluation (vide = tous)" className={champ} value={form.evaluation as string} onChange={(e) => set("evaluation", e.target.value)} />
        <input aria-label="Lien officiel" placeholder="Lien officiel https://…" className={champ} value={form.lien_officiel as string} onChange={(e) => set("lien_officiel", e.target.value)} />
        <label className="text-xs text-slate">
          Date de début
          <input type="date" aria-label="Date de début" className={champ} value={form.date_debut as string} onChange={(e) => set("date_debut", e.target.value)} />
        </label>
        <label className="text-xs text-slate">
          Date de fin (facultative)
          <input type="date" aria-label="Date de fin" className={champ} value={form.date_fin as string} onChange={(e) => set("date_fin", e.target.value)} />
        </label>
        <button onClick={creer} className="min-h-[44px] rounded-full bg-ink px-4 text-sm text-paper sm:col-span-2">
          Ajouter l'événement
        </button>
      </div>
      {!liste ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <ul className="space-y-2">
          {liste.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-soft/15 bg-paper-raised p-3 text-sm">
              <span className="font-mono-tag w-24 text-[11px] text-slate">{e.date_debut}</span>
              <span className="min-w-0 flex-1">
                {e.titre} <span className="text-xs text-slate">· {e.type}{e.evaluation ? ` · ${e.evaluation}` : ""}</span>
              </span>
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={e.visible} onChange={() => basculer(e)} /> Visible
              </label>
              <button aria-label={`Supprimer ${e.titre}`} onClick={() => setASupprimer(e)} className="min-h-[44px] min-w-[44px] text-correction">
                <Trash2 size={16} className="mx-auto" />
              </button>
            </li>
          ))}
          {liste.length === 0 && <li className="text-sm text-slate">Aucun événement.</li>}
        </ul>
      )}
      {aSupprimer && (
        <ConfirmDialog tone="danger" title={`Supprimer « ${aSupprimer.titre} » ?`} message="L'événement disparaît du calendrier public." onConfirm={supprimer} onClose={() => setASupprimer(null)} />
      )}
    </div>
  );
}
