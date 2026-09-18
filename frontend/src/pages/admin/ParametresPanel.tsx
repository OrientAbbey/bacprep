import { useCallback, useEffect, useState } from "react";
import { Check, Pencil, Plus, Settings2, Trash2, X } from "lucide-react";
import { ApiError, api } from "../../api/client";
import { ReferentielOption, ReferentielOptions, ReferentielScope } from "../../api/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { authHeaders, purgerSessionExpiree } from "./shared";

interface Props {
  token: string;
}

/** Métadonnées d'affichage par liste du référentiel (ordre du panneau). */
const SCOPES: { scope: ReferentielScope; titre: string; description: string; codePh: string; labelPh: string }[] = [
  { scope: "niveau", titre: "Niveaux", description: "Grands niveaux du système scolaire", codePh: "ex. SECONDAIRE", labelPh: "ex. secondaire" },
  { scope: "classe", titre: "Classes", description: "Classes du secondaire", codePh: "ex. terminale", labelPh: "ex. Terminale" },
  { scope: "evaluation", titre: "Évaluations", description: "Types d'évaluation (examens, sequences…)", codePh: "ex. BAC", labelPh: "ex. Baccalauréat" },
  { scope: "matiere", titre: "Matières", description: "Disciplines — s'alimente à l'usage", codePh: "ex. Mathématiques", labelPh: "" },
  { scope: "serie", titre: "Séries / filières", description: "Séries du BAC, filières", codePh: "ex. TI", labelPh: "" },
];

/** Onglet « Paramètres » du back-office : tables énumératives du référentiel
 * consommées par les formulaires d'épreuve (table `referentiel_options`).
 * Chaque liste permet d'ajouter, renommer (libellé + valeur) et supprimer
 * une option — la suppression d'une valeur encore utilisée par des épreuves
 * est confirmée (compteur `en_usage`) : les épreuves gardent leur valeur,
 * seule la liste change. */
export function ParametresPanel({ token }: { token: string }) {
  const { showToast } = useToast();
  const [data, setData] = useState<ReferentielOptions | null>(null);
  const [erreur, setErreur] = useState(false);
  // Formulaire d'ajout par scope (code + libellé optionnel).
  const [ajouts, setAjouts] = useState<Record<string, { code: string; label: string }>>({});
  // Option en cours de renommage — « id » null = aucun.
  const [enEdition, setEnEdition] = useState<{ id: string; code: string; label: string } | null>(null);
  // Suppression en attente de confirmation (avec contexte du scope).
  const [aSupprimer, setASupprimer] = useState<{ scope: ReferentielScope; option: ReferentielOption } | null>(null);

  const load = useCallback(() => {
    setErreur(false);
    api
      .get<ReferentielOptions>("/api/admin/referentiel-options", authHeaders(token))
      .then((all) => {
        setData(all);
        setEnEdition(null);
      })
      .catch((err) => {
        if (!purgerSessionExpiree(err)) setErreur(true);
      });
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  function erreurServeur(err: unknown): string {
    if (err instanceof ApiError) {
      const d = err.detail as string | { detail?: string } | null;
      if (typeof d === "string") return d;
      if (d?.detail) return d.detail;
    }
    return "";
  }

  function addSort(scope: ReferentielScope) {
    const form = ajouts[scope] ?? { code: "", label: "" };
    const code = form.code.trim();
    if (!code) return;
    void api
      .post<{ id: string }>(
        "/api/admin/referentiel-options",
        { scope, code, label: form.label.trim() || undefined },
        authHeaders(token)
      )
      .then(() => {
        showToast(`« ${code} » ajouté aux ${SCOPES.find((s) => s.scope === scope)?.titre}.`, "success");
        setAjouts((a) => ({ ...a, [scope]: { code: "", label: "" } }));
        load();
      })
      .catch((err) => {
        const m = erreurServeur(err);
        showToast(m || "L'ajout a échoué — réessaie.", "error");
      });
  }

  function saveEdition(scope: ReferentielScope) {
    if (!enEdition) return;
    const code = enEdition.code.trim();
    if (!code) return;
    void api
      .patch<{ id: string; code: string; label: string }>(
        `/api/admin/referentiel-options/${enEdition.id}`,
        { code, label: enEdition.label.trim() || null },
        authHeaders(token)
      )
      .then(() => {
        showToast("Option mise à jour.", "success");
        setEnEdition(null);
        load();
      })
      .catch((err: unknown) => {
        const m = erreurServeur(err);
        showToast(m || "Le renommage a échoué — réessaie.", "error");
      });
  }

  function demanderSuppression(scope: ReferentielScope, option: ReferentielOption) {
    setASupprimer({ scope, option });
  }

  function confirmerSuppression() {
    if (!aSupprimer) return;
    void api
      .del<{ ok: boolean }>(`/api/admin/referentiel-options/${aSupprimer.option.id}`, authHeaders(token))
      .then(() => {
        showToast(`« ${aSupprimer.option.label} » supprimé de la liste.`, "info");
        setASupprimer(null);
        load();
      })
      .catch(() => {
        setASupprimer(null);
        showToast("La suppression a échoué — réessaie.", "error");
      });
  }

  if (erreur)
    return (
      <div
        role="alert"
        className="rounded-lg border border-correction/30 bg-correction-soft p-5 text-sm text-correction"
      >
        <p>Les listes du référentiel n'ont pas pu être chargées.</p>
        <button type="button" onClick={load} className="mt-2 underline">
          Réessayer
        </button>
      </div>
    );
  if (!data)
    return (
      <div className="space-y-2 rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className={`h-16 ${i % 2 === 0 ? "w-full" : "w-3/4"}`} />
        ))}
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Settings2 size={18} strokeWidth={1.75} aria-hidden="true" className="text-highlight" />
        <h2 className="font-serif-brand text-lg">Paramètres — référentiels</h2>
        <span className="font-mono-tag text-[10px] text-slate">
          listes proposées dans les formulaires d'épreuve — s'alimentent aussi à l'usage
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {SCOPES.map((meta) => {
          const options = data[meta.scope] ?? [];
          return (
            <div
              key={meta.scope}
              className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4"
            >
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="font-serif-brand text-base">{meta.titre}</h3>
                <span className="font-mono-tag text-[10px] text-slate">{options.length} option(s)</span>
              </div>
              <p className="mb-3 text-xs text-slate">{meta.description}</p>

              {options.length > 0 && (
                <ul className="divide-y divide-ink-soft/10">
                  {options.map((o) => (
                    <li key={o.id} className="py-1.5">
                      {enEdition?.id === o.id ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <input
                            value={enEdition.code}
                            onChange={(e) => setEnEdition((ed) => (ed ? { ...ed, code: e.target.value } : ed))}
                            aria-label="Valeur (code) de l'option"
                            className="min-h-[44px] w-32 rounded-[2px] border border-ink-soft/25 bg-paper px-2 font-mono text-xs"
                          />
                          <input
                            value={enEdition.label}
                            onChange={(e) => setEnEdition((ed) => (ed ? { ...ed, label: e.target.value } : ed))}
                            aria-label="Libellé affiché"
                            placeholder="Libellé"
                            className="min-h-[44px] flex-1 rounded-[2px] border border-ink-soft/25 bg-paper px-2 text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => saveEdition(meta.scope)}
                            title="Enregistrer"
                            aria-label="Enregistrer le renommage"
                            className="relative flex h-8 w-8 items-center justify-center rounded-full bg-valide text-paper after:absolute after:-inset-1.5 after:rounded-full after:content-['']"
                          >
                            <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnEdition(null)}
                            title="Annuler"
                            aria-label="Annuler le renommage"
                            className="relative flex h-8 w-8 items-center justify-center rounded-full border border-ink-soft/25 after:absolute after:-inset-1.5 after:rounded-full after:content-['']"
                          >
                            <X size={14} strokeWidth={2} aria-hidden="true" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm">
                            <span className="font-medium">{o.label || o.code}</span>
                            {o.label !== o.code && (
                              <span className="ml-1.5 font-mono-tag text-[10px] text-slate">{o.code}</span>
                            )}
                          </span>
                          {o.en_usage > 0 && (
                            <span
                              className="rounded-full bg-highlight-soft px-2 py-0.5 font-mono-tag text-[10px] text-highlight"
                              title={`${o.en_usage} épreuve(s) utilisent encore cette valeur`}
                            >
                              {o.en_usage} ép.
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => setEnEdition({ id: o.id, code: o.code, label: o.label === o.code ? "" : o.label })}
                            title="Renommer cette option"
                            aria-label={`Renommer ${o.label}`}
                            className="relative flex h-7 w-7 items-center justify-center rounded-full text-ink-soft hover:bg-highlight-soft hover:text-highlight after:absolute after:-inset-2 after:rounded-full after:content-['']"
                          >
                            <Pencil size={13} strokeWidth={1.75} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => demanderSuppression(meta.scope, o)}
                            title="Supprimer de la liste"
                            aria-label={`Supprimer ${o.label} de la liste`}
                            className="relative flex h-7 w-7 items-center justify-center rounded-full text-ink-soft hover:bg-correction-soft hover:text-correction after:absolute after:-inset-2 after:rounded-full after:content-['']"
                          >
                            <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {options.length === 0 && (
                <p className="mb-2 text-xs text-slate">Liste vide — alimentée dès qu'une valeur est saisie.</p>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-ink-soft/10 pt-2">
                <input
                  value={ajouts[meta.scope]?.code ?? ""}
                  onChange={(e) =>
                    setAjouts((a) => ({ ...a, [meta.scope]: { code: e.target.value, label: a[meta.scope]?.label ?? "" } }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addSort(meta.scope);
                    }
                  }}
                  placeholder={meta.codePh}
                  aria-label={`Nouvelle valeur — ${meta.titre}`}
                  className="min-h-[44px] w-40 rounded-[2px] border border-ink-soft/25 bg-paper px-2 text-xs"
                />
                {meta.labelPh && (
                  <input
                    value={ajouts[meta.scope]?.label ?? ""}
                    onChange={(e) =>
                      setAjouts((a) => ({ ...a, [meta.scope]: { code: a[meta.scope]?.code ?? "", label: e.target.value } }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addSort(meta.scope);
                      }
                    }}
                    placeholder={meta.labelPh}
                    aria-label={`Libellé affiché — ${meta.titre}`}
                    className="min-h-[44px] flex-1 rounded-[2px] border border-ink-soft/25 bg-paper px-2 text-xs"
                  />
                )}
                <button
                  type="button"
                  onClick={() => addSort(meta.scope)}
                  className="flex min-h-[44px] items-center gap-1 rounded-full bg-ink px-3 text-xs font-medium text-paper"
                >
                  <Plus size={13} strokeWidth={2.5} aria-hidden="true" />
                  Ajouter
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {aSupprimer && (
        <ConfirmDialog
          tone="danger"
          title={`Supprimer « ${aSupprimer.option.label} » ?`}
          message={
            aSupprimer.option.en_usage > 0
              ? `${aSupprimer.option.en_usage} épreuve(s) utilisent encore cette valeur : elles GARDERONT leur valeur, seule la liste change. Supprimer quand même ?`
              : "Cette valeur n'est utilisée par aucune épreuve. Supprimer ?"
          }
          onConfirm={confirmerSuppression}
          onClose={() => setASupprimer(null)}
        />
      )}
    </div>
  );
}