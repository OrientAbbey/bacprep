import { useEffect, useState } from "react";
import { Ban, ShieldCheck } from "lucide-react";
import { ApiError, api } from "../../api/client";
import { AdminUtilisateur } from "../../api/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { classeLabel } from "../../lib/referentiel";
import { formatRelativeTime } from "../../lib/time";
import { authHeaders, purgerSessionExpiree } from "./shared";

/** Table « Utilisateurs » : une ligne par compte (élèves ET admins — les
 * comptes admin portent le badge Admin/racine et échappent à la modération
 * bannir/supprimer), identité déclarée + consentements + compteurs d'usage,
 * et les actions de modération (bannir/débannir/supprimer) + gouvernance
 * (promouvoir/révoquer, réservé côté serveur à l'admin root). Volontairement
 * SANS donnée sensible : rien de secret n'est stocké dans le produit
 * (connexion Google/mock, paiement par référence d'agrégateur), et la table
 * ne présente que ce que l'utilisateur a accepté de partager. */
export function UtilisateursPanel({ token }: { token: string }) {
  const { showToast } = useToast();
  const [rows, setRows] = useState<AdminUtilisateur[] | null>(null);
  const [erreur, setErreur] = useState(false);
  // Suppression définitive d'un compte : action irréversible, confirmation
  // explicite via la boîte de dialogue accessible (remplace window.confirm).
  const [aSupprimer, setASupprimer] = useState<AdminUtilisateur | null>(null);

  function load() {
    setErreur(false);
    api
      .get<AdminUtilisateur[]>("/api/admin/utilisateurs", authHeaders(token))
      .then(setRows)
      .catch((err) => {
        if (!purgerSessionExpiree(err)) setErreur(true);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /** Message d'erreur renvoyé par le serveur (ex. 403 « Seul l'admin root
   * peut promouvoir… ») ou libellé de repli local. */
  function messageErreur(err: unknown, defaut: string): string {
    if (err instanceof ApiError) {
      const d = err.detail as string | { detail?: string } | null;
      if (typeof d === "string") return d;
      if (d?.detail) return d.detail;
    }
    return defaut;
  }

  async function bannir(u: AdminUtilisateur) {
    const motif = window.prompt(`Motif du bannissement de ${u.email} (optionnel) :`) ?? "";
    try {
      await api.post(`/api/admin/utilisateurs/${u.id}/bannir`, { motif }, authHeaders(token));
      showToast(`${u.email} banni — sa session est fermée immédiatement.`, "success");
      load();
    } catch (err) {
      if (!purgerSessionExpiree(err)) showToast("Le bannissement a échoué — réessaie.", "error");
    }
  }

  async function debannir(u: AdminUtilisateur) {
    try {
      await api.post(`/api/admin/utilisateurs/${u.id}/debannir`, undefined, authHeaders(token));
      showToast(`${u.email} peut se reconnecter.`, "success");
      load();
    } catch (err) {
      if (!purgerSessionExpiree(err)) showToast("Le débannissement a échoué — réessaie.", "error");
    }
  }

  async function supprimer(u: AdminUtilisateur) {
    setASupprimer(u);
  }

  async function confirmerSuppression() {
    if (!aSupprimer) return;
    try {
      await api.del(`/api/admin/utilisateurs/${aSupprimer.id}`, authHeaders(token));
      showToast(`${aSupprimer.email} et ses données ont été supprimés.`, "info");
      setASupprimer(null);
      load();
    } catch (err) {
      if (!purgerSessionExpiree(err)) showToast("La suppression a échoué — réessaie.", "error");
    }
  }

  // Promotion/révocation d'admin délégué : réservées AU SERVEUR à l'admin
  // root (403 sinon). Le libellé du refus est affiché tel quel dans le toast.
  async function promouvoir(u: AdminUtilisateur) {
    try {
      await api.post(`/api/admin/utilisateurs/${u.id}/promouvoir`, undefined, authHeaders(token));
      showToast(`${u.email} est maintenant administrateur délégué.`, "success");
      load();
    } catch (err) {
      if (!purgerSessionExpiree(err))
        showToast(messageErreur(err, "La promotion a échoué — réessaie."), "error");
    }
  }

  async function demouvoir(u: AdminUtilisateur) {
    try {
      await api.post(`/api/admin/utilisateurs/${u.id}/demouvoir`, undefined, authHeaders(token));
      showToast(`${u.email} a récupéré un rôle d'élève.`, "info");
      load();
    } catch (err) {
      if (!purgerSessionExpiree(err))
        showToast(messageErreur(err, "La révocation a échoué — réessaie."), "error");
    }
  }

  if (erreur)
    return (
      <div
        role="alert"
        className="rounded-lg border border-correction/30 bg-correction-soft p-5 text-sm text-correction"
      >
        <p>La liste des utilisateurs n'a pas pu être chargée.</p>
        <button type="button" onClick={load} className="mt-2 underline">
          Réessayer
        </button>
      </div>
    );
  if (!rows)
    return (
      <div className="space-y-2 rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className={`h-4 ${i % 2 === 0 ? "w-full" : "w-2/3"}`} />
        ))}
      </div>
    );
  if (rows.length === 0)
    return (
      <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5 text-sm text-slate">
        Aucun utilisateur inscrit pour l'instant.
      </div>
    );

  return (
    <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck size={18} strokeWidth={1.75} aria-hidden="true" className="text-highlight" />
        <h2 className="font-serif-brand text-lg">Utilisateurs</h2>
        <span className="font-mono-tag text-[10px] text-slate">
          informations de compte et compteurs d'usage — aucune donnée secrète
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead>
            <tr className="border-b border-ink-soft/20 font-mono-tag text-[10px] text-ink-soft">
              <th className="py-2 pr-3">Utilisateur</th>
              <th className="py-2 pr-3">Profil</th>
              <th className="py-2 pr-3">Consentements</th>
              <th className="py-2 pr-3 text-right">Notes</th>
              <th className="py-2 pr-3 text-right">Discut. IA</th>
              <th className="py-2 pr-3 text-right">Consult.</th>
              <th className="py-2 pr-3 text-right">Abo. actifs</th>
              <th className="py-2 pr-3 text-right">Dépensé (FCFA)</th>
              <th className="py-2 pr-3">Dernière connexion</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-soft/10">
            {rows.map((u) => (
              <tr key={u.id} className={u.banni ? "bg-correction-soft/40" : undefined}>
                <td className="py-2 pr-3">
                  <p className="font-medium">{u.nom || "—"}</p>
                  <p className="font-mono-tag text-[10px] text-slate">{u.email}</p>
                  {u.is_admin && (
                    <span
                      className={`mt-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono-tag text-[10px] ${
                        u.racine ? "bg-correction-soft text-correction" : "bg-highlight-soft text-highlight"
                      }`}
                    >
                      <ShieldCheck size={10} strokeWidth={2} aria-hidden="true" />
                      {u.racine ? "Admin racine" : "Admin délégué"}
                    </span>
                  )}
                  {u.banni && (
                    <p className="mt-0.5 font-mono-tag text-[10px] text-correction">
                      BANNI{u.banni_motif ? ` — ${u.banni_motif}` : ""}
                    </p>
                  )}
                </td>
                <td className="py-2 pr-3 text-xs text-ink-soft">
                  {u.niveau || u.classe || u.etablissement ? (
                    <>
                      {u.niveau || ""}
                      {u.classe ? `${u.niveau ? " · " : ""}${classeLabel(u.classe)}` : ""}
                      {u.etablissement ? (
                        <>
                          <br />
                          {u.etablissement}
                        </>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-slate">Non renseigné</span>
                  )}
                </td>
                <td className="py-2 pr-3 text-xs">
                  <span className={u.consent_ia === false ? "text-correction" : "text-valide"}>
                    IA {u.consent_ia === null ? "?" : u.consent_ia ? "oui" : "non"}
                  </span>
                  {" · "}
                  <span className={u.consent_notes === false ? "text-correction" : "text-valide"}>
                    notes {u.consent_notes === null ? "?" : u.consent_notes ? "oui" : "non"}
                  </span>
                </td>
                <td className="py-2 pr-3 text-right">{u.notes}</td>
                <td className="py-2 pr-3 text-right">{u.discussions_ia}</td>
                <td className="py-2 pr-3 text-right">{u.consultations}</td>
                <td className="py-2 pr-3 text-right">{u.abonnements_actifs}</td>
                <td className="py-2 pr-3 text-right">{u.total_depense_fcfa.toLocaleString("fr-FR")}</td>
                <td className="py-2 pr-3 font-mono-tag text-[10px] text-slate">
                  {u.derniere_connexion ? formatRelativeTime(u.derniere_connexion) : "—"}
                </td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-1.5">
                    {/* Admins : pas de modération bannir/supprimer. Le racine
                        n'est ni révocable ni listé en action ; le délégué peut
                        être révoqué (le serveur n'accepte que si l'admin
                        courant est ROOT). */}
                    {u.is_admin ? (
                      u.racine ? (
                        <span className="font-mono-tag text-[10px] text-slate">Compte racine — non modifiable</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => demouvoir(u)}
                          title="Révocation réservée à l'admin root (colonne users.role)"
                          className="min-h-[44px] rounded-full border border-correction/40 px-3 text-xs font-medium text-correction hover:bg-correction-soft/40"
                        >
                          Démouvoir
                        </button>
                      )
                    ) : (
                      <>
                        {u.banni ? (
                          <button
                            type="button"
                            onClick={() => debannir(u)}
                            className="flex min-h-[44px] items-center gap-1 rounded-full border border-valide/40 px-3 text-xs font-medium text-valide hover:bg-valide-soft/40"
                          >
                            <ShieldCheck size={12} strokeWidth={2} aria-hidden="true" />
                            Débannir
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => bannir(u)}
                            className="flex min-h-[44px] items-center gap-1 rounded-full border border-ink-soft/25 px-3 text-xs font-medium text-ink-soft hover:border-correction/50 hover:text-correction"
                          >
                            <Ban size={12} strokeWidth={2} aria-hidden="true" />
                            Bannir
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => supprimer(u)}
                          className="min-h-[44px] rounded-full border border-correction/40 px-3 text-xs font-medium text-correction hover:bg-correction-soft/40"
                        >
                          Supprimer
                        </button>
                        <button
                          type="button"
                          onClick={() => promouvoir(u)}
                          title="Promotion réservée à l'admin root"
                          className="min-h-[44px] rounded-full border border-ink-soft/25 px-3 text-xs font-medium text-ink-soft hover:border-highlight/50 hover:text-highlight"
                        >
                          Promouvoir
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {aSupprimer && (
        <ConfirmDialog
          tone="danger"
          title="Supprimer ce compte utilisateur ?"
          message={`Supprimer définitivement ${aSupprimer.email} et TOUTES ses données (notes, discussions, abonnements, paiements) ? Action irréversible.`}
          onConfirm={confirmerSuppression}
          onClose={() => setASupprimer(null)}
        />
      )}
    </div>
  );
}