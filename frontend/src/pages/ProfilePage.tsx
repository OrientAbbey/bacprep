import { useEffect, useState } from "react";
import { api } from "../api/client";
import { SubscriptionOut } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { getInitials } from "../lib/initials";

interface Profil {
  email: string;
  nom: string;
  membre_depuis: string;
  abonnements: SubscriptionOut[];
  total_depense_fcfa: number;
}

export function ProfilePage() {
  const [profil, setProfil] = useState<Profil | null>(null);
  const { logout } = useAuth();

  async function refresh() {
    setProfil(await api.get<Profil>("/api/me/profil"));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function cancel(subId: string) {
    if (!confirm("Annuler cet abonnement ? L'accès sera révoqué immédiatement.")) return;
    await api.post(`/api/subscriptions/${subId}/cancel`);
    refresh();
  }

  if (!profil) return <p className="text-sm text-slate">Chargement…</p>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-6">
        <div className="flex items-center gap-4">
          <div
            aria-hidden="true"
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-ink font-mono-tag text-lg font-semibold text-paper"
          >
            {getInitials(profil.nom)}
          </div>
          <div>
            <h1 className="font-serif-brand text-2xl">{profil.nom}</h1>
            <p className="text-sm text-ink-soft">{profil.email}</p>
          </div>
        </div>
        <p className="mt-3 text-sm text-slate">
          Membre depuis le {new Date(profil.membre_depuis).toLocaleDateString("fr-FR")}
        </p>
        <p className="text-sm text-slate">Total dépensé : {profil.total_depense_fcfa} FCFA</p>
        <button
          onClick={logout}
          className="mt-4 min-h-[44px] rounded-full border border-correction/40 px-5 text-sm font-medium text-correction"
        >
          Se déconnecter
        </button>
      </div>

      <div>
        <h2 className="mb-3 font-serif-brand text-lg">Abonnements actifs</h2>
        {profil.abonnements.length === 0 && (
          <p className="text-sm text-slate">Aucun abonnement actif pour l'instant.</p>
        )}
        <div className="space-y-3">
          {profil.abonnements.map((s) => (
            <div key={s.id} className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
              <p className="font-medium">{s.scope_label}</p>
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between border-b border-dashed border-ink-soft/15 py-1">
                  <dt className="text-ink-soft">Filière</dt>
                  <dd>{s.filiere}</dd>
                </div>
                {s.matiere !== "ALL" && (
                  <div className="flex justify-between border-b border-dashed border-ink-soft/15 py-1">
                    <dt className="text-ink-soft">Matière</dt>
                    <dd>{s.matiere}</dd>
                  </div>
                )}
                {s.annee !== "ALL" && (
                  <div className="flex justify-between border-b border-dashed border-ink-soft/15 py-1">
                    <dt className="text-ink-soft">Année</dt>
                    <dd>{s.annee}</dd>
                  </div>
                )}
                {s.epreuve_label && (
                  <div className="flex justify-between border-b border-dashed border-ink-soft/15 py-1">
                    <dt className="text-ink-soft">Épreuve</dt>
                    <dd>{s.epreuve_label}</dd>
                  </div>
                )}
                <div className="flex justify-between border-b border-dashed border-ink-soft/15 py-1">
                  <dt className="text-ink-soft">Épreuves couvertes</dt>
                  <dd>{s.epreuves_couvertes}</dd>
                </div>
                <div className="flex justify-between border-b border-dashed border-ink-soft/15 py-1">
                  <dt className="text-ink-soft">Souscrit le</dt>
                  <dd>{new Date(s.start_date).toLocaleDateString("fr-FR")}</dd>
                </div>
                <div className="flex justify-between py-1">
                  <dt className="text-ink-soft">Expire le</dt>
                  <dd>{new Date(s.end_date).toLocaleDateString("fr-FR")}</dd>
                </div>
              </dl>
              <button
                onClick={() => cancel(s.id)}
                className="mt-3 min-h-[36px] rounded-full border border-correction/40 px-4 text-xs font-medium text-correction"
              >
                Annuler cet abonnement
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
