import { useEffect, useState } from "react";
import { Bell, Plus, Trash2, X } from "lucide-react";
import { api } from "../../api/client";
import { NotificationAdmin, TypeNotification } from "../../api/types";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { formatRelativeTime } from "../../lib/time";
import { authHeaders, Field, Select, purgerSessionExpiree } from "./shared";

/** Types proposés pour une notification — libellés d'interface, codes
 * stockés côté serveur. `nouvelle_epreuve` est aussi posé automatiquement
 * à la publication d'épreuve. */
const TYPES: { value: TypeNotification; label: string }[] = [
  { value: "information", label: "Information" },
  { value: "nouvelle_epreuve", label: "Nouvelle épreuve" },
  { value: "modification", label: "Modification" },
  { value: "maintenance", label: "Maintenance" },
];

const TYPE_LABELS = Object.fromEntries(TYPES.map((t) => [t.value, t.label])) as Record<
  TypeNotification,
  string
>;

interface Formulaire {
  titre: string;
  message: string;
  type: TypeNotification;
  actif: boolean;
}

const FORMULAIRE_VIDE: Formulaire = { titre: "", message: "", type: "information", actif: true };

/** Notifications diffusées à tous les utilisateurs : création, modification,
 *  activation/désactivation et suppression. Le lien d'épreuve (optionnel)
 *  propose un « aller à l'épreuve » dans la cloche des élèves. */
export function NotificationsPanel({ token }: { token: string }) {
  const { showToast } = useToast();
  const [notif, setNotif] = useState<NotificationAdmin[] | null>(null);
  const [erreur, setErreur] = useState(false);
  const [edition, setEdition] = useState<{ id: string | null; form: Formulaire } | null>(null);

  function load() {
    setErreur(false);
    api
      .get<NotificationAdmin[]>("/api/admin/notifications", authHeaders(token))
      .then(setNotif)
      .catch((err) => {
        if (!purgerSessionExpiree(err)) setErreur(true);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function sauvegarder(id: string | null, form: Formulaire) {
    try {
      if (id === null) {
        await api.post("/api/admin/notifications", { ...form }, authHeaders(token));
        showToast("Notification créée.", "success");
      } else {
        await api.put(`/api/admin/notifications/${id}`, { ...form }, authHeaders(token));
        showToast("Notification mise à jour.", "success");
      }
      setEdition(null);
      load();
    } catch {
      showToast("Échec de l'enregistrement de la notification.", "error");
    }
  }

  async function basculer(n: NotificationAdmin) {
    try {
      await api.post(`/api/admin/notifications/${n.id}/toggle`, undefined, authHeaders(token));
      showToast(n.actif ? "Notification désactivée." : "Notification activée.", "success");
      load();
    } catch {
      showToast("Échec de l'activation de la notification.", "error");
    }
  }

  async function supprimer(n: NotificationAdmin) {
    try {
      await api.del(`/api/admin/notifications/${n.id}`, authHeaders(token));
      showToast("Notification supprimée.", "success");
      load();
    } catch {
      showToast("Échec de la suppression de la notification.", "error");
    }
  }

  if (erreur)
    return (
      <div
        role="alert"
        className="rounded-lg border border-correction/30 bg-correction-soft p-5 text-sm text-correction"
      >
        <p>Les notifications n'ont pas pu être chargées.</p>
        <button type="button" onClick={load} className="mt-2 underline">
          Réessayer
        </button>
      </div>
    );
  if (!notif)
    return (
      <div className="space-y-2 rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className={`h-4 ${i % 2 === 0 ? "w-full" : "w-2/3"}`} />
        ))}
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-serif-brand text-lg">Notifications</h2>
        <button
          type="button"
          onClick={() => setEdition(edition === null ? { id: null, form: FORMULAIRE_VIDE } : null)}
          className="flex min-h-[40px] items-center gap-1.5 rounded-full border border-ink-soft/25 px-4 text-sm"
        >
          {edition === null ? (
            <>
              <Plus size={15} strokeWidth={1.75} aria-hidden="true" />
              Nouvelle notification
            </>
          ) : (
            <>
              <X size={15} strokeWidth={1.75} aria-hidden="true" />
              Annuler
            </>
          )}
        </button>
      </div>

      {edition && (
        <FormulaireNotification
          form={edition.form}
          onFormChange={(form) => setEdition({ ...edition, form })}
          onSave={() => sauvegarder(edition.id, edition.form)}
        />
      )}

      {notif.length === 0 && edition === null ? (
        <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5 text-sm text-slate">
          Aucune notification — créez la première pour informer les utilisateurs.
        </div>
      ) : (
        <ul className="space-y-3">
          {notif.map((n) => (
            <li
              key={n.id}
              className={`rounded-lg border bg-paper-raised p-4 ${
                n.actif ? "border-ink-soft/15" : "border-ink-soft/15 opacity-60"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Bell size={15} strokeWidth={1.75} aria-hidden="true" className="text-ink-soft" />
                <p className="font-medium">{n.titre}</p>
                <span
                  className={`rounded-full px-2.5 py-0.5 font-mono-tag text-[10px] ${
                    n.actif ? "bg-valide-soft text-valide" : "bg-correction-soft text-correction"
                  }`}
                >
                  {n.actif ? "Active" : "Inactive"}
                </span>
                <span className="rounded-full bg-highlight-soft px-2.5 py-0.5 font-mono-tag text-[10px] text-highlight">
                  {TYPE_LABELS[n.type] ?? n.type}
                </span>
              </div>
              {n.message && <p className="mt-2 text-sm text-ink-soft">« {n.message} »</p>}
              <p className="mt-2 font-mono-tag text-[10px] text-slate">
                {n.epreuve_id ? `Épreuve liée · ` : ""}
                {formatRelativeTime(n.created_at)}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setEdition({ id: n.id, form: { titre: n.titre, message: n.message, type: n.type, actif: n.actif } })
                  }
                  className="min-h-[40px] rounded-full border border-ink-soft/25 px-4 text-xs"
                >
                  Modifier
                </button>
                <button
                  type="button"
                  onClick={() => basculer(n)}
                  className={`min-h-[40px] rounded-full border px-4 text-xs font-medium ${
                    n.actif
                      ? "border-correction/40 text-correction hover:bg-correction-soft/40"
                      : "border-valide/40 text-valide hover:bg-valide-soft/40"
                  }`}
                >
                  {n.actif ? "Désactiver" : "Activer"}
                </button>
                <button
                  type="button"
                  onClick={() => supprimer(n)}
                  className="flex min-h-[40px] items-center gap-1.5 rounded-full border border-correction/40 px-4 text-xs text-correction hover:bg-correction-soft/40"
                >
                  <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                  Supprimer
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Formulaire de création / modification d'une notification. */
function FormulaireNotification({
  form,
  onFormChange,
  onSave,
}: {
  form: Formulaire;
  onFormChange: (f: Formulaire) => void;
  onSave: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (form.titre.trim()) onSave();
      }}
      className="space-y-3 rounded-lg border border-ink-soft/20 bg-paper-raised p-4"
    >
      <Field
        label="Titre (obligatoire)"
        value={form.titre}
        onChange={(titre) => onFormChange({ ...form, titre })}
        placeholder="Ex. Nouvelle épreuve disponible"
      />
      <div>
        <label htmlFor="notification-message" className="mb-1 block font-mono-tag text-[10px] text-ink-soft">
          Message
        </label>
        <textarea
          id="notification-message"
          rows={3}
          value={form.message}
          onChange={(e) => onFormChange({ ...form, message: e.target.value })}
          placeholder="Détail de la notification (optionnel)…"
          className="w-full rounded-[2px] border border-ink-soft/25 bg-paper p-3 text-sm"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Type"
          value={form.type}
          onChange={(type) => onFormChange({ ...form, type: type as TypeNotification })}
          options={TYPES}
        />
        <Select
          label="État"
          value={form.actif ? "oui" : "non"}
          onChange={(v) => onFormChange({ ...form, actif: v === "oui" })}
          options={[
            { value: "oui", label: "Active (visible par tous)" },
            { value: "non", label: "Inactive (masquée)" },
          ]}
        />
      </div>
      <button
        type="submit"
        disabled={!form.titre.trim()}
        className="min-h-[44px] rounded-full bg-ink px-5 text-sm font-medium text-paper disabled:opacity-40"
      >
        Enregistrer
      </button>
    </form>
  );
}