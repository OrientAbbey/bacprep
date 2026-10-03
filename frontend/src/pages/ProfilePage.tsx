import {
  Activity,
  Bot,
  BookOpen,
  Calendar,
  CheckCircle2,
  CreditCard,
  Database,
  Edit3,
  FileText,
  GraduationCap,
  LogIn,
  Pencil,
  Plus,
  StickyNote,
  Trash2,
} from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { ActiviteItem, Note, SubscriptionOut } from "../api/types";
import { useAuth, type User } from "../auth/AuthProvider";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { NoteEditor } from "../components/NoteEditor";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { CLASSES_SECONDAIRE, NIVEAUX, classeLabel } from "../lib/referentiel";
import { formatRelativeTime } from "../lib/time";
import { getInitials } from "../lib/initials";

interface Profil {
  email: string;
  nom: string;
  niveau: string | null;
  classe: string | null;
  etablissement: string | null;
  membre_depuis: string;
  abonnements: SubscriptionOut[];
  total_depense_fcfa: number;
}

const ICONE_ACTIVITE: Record<string, typeof Activity> = {
  connexion: LogIn,
  consultation: GraduationCap,
  abonnement: Plus,
  paiement: CreditCard,
  note: StickyNote,
  discussion_ia: Bot,
};

type OngletProfil = "abonnements" | "notes" | "activite" | "donnees";

const ONGLETS_PROFIL: [OngletProfil, string][] = [
  ["abonnements", "Abonnements"],
  ["notes", "Mes notes"],
  ["activite", "Activité"],
  ["donnees", "Confidentialité"],
];

export function ProfilePage() {
  const [profil, setProfil] = useState<Profil | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [activite, setActivite] = useState<ActiviteItem[]>([]);
  const [onglet, setOnglet] = useState<OngletProfil>("abonnements");
  const [noteEdition, setNoteEdition] = useState<Note | null>(null);
  const [erreurChargement, setErreurChargement] = useState(false);
  // Confirmation en attente : annule l'abonnement ou supprime une note.
  // Le `tone` voyage AVEC la confirmation : un drapeau global était
  // obligatoire parce que les deux confirmations le partageaient, et il
  // restait figé à `true` après le premier usage — la branche « default »
  // était morte et une confirmation non destructive aurait été peinte en
  // rouge. Chaque confirmation choisit désormais sa propre couleur.
  const [confirmation, setConfirmation] = useState<{
    titre: string;
    message: string;
    tone: "default" | "danger";
    action: () => void | Promise<void>;
  } | null>(null);
  // Formulaire d'infos étendues (édition locale, sauvegarde explicite).
  const [form, setForm] = useState({ nom: "", niveau: "", classe: "", etablissement: "" });
  const [formOuvert, setFormOuvert] = useState(false);
  const [savingProfil, setSavingProfil] = useState(false);
  const { logout, user, refreshConsentement } = useAuth();
  const { showToast } = useToast();
  // Consentement : réglages locaux, synchronisés au compte (révocables à
  // tout moment — pratique RGPD).
  const [consentIa, setConsentIa] = useState<boolean>(user?.consent_ia !== false);
  const [consentNotes, setConsentNotes] = useState<boolean>(user?.consent_notes !== false);
  const [savingConsent, setSavingConsent] = useState(false);
  const tabRefs = useRef<Map<OngletProfil, HTMLButtonElement>>(new Map());

  // Navigation clavier des onglets (WAI-ARIA) : flèches, Home/End.
  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const index = ONGLETS_PROFIL.findIndex(([v]) => v === onglet);
    let nextIndex: number;
    if (e.key === "ArrowRight") nextIndex = (index + 1) % ONGLETS_PROFIL.length;
    else if (e.key === "ArrowLeft") nextIndex = (index - 1 + ONGLETS_PROFIL.length) % ONGLETS_PROFIL.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = ONGLETS_PROFIL.length - 1;
    else return;
    e.preventDefault();
    const [valeur] = ONGLETS_PROFIL[nextIndex];
    setOnglet(valeur);
    tabRefs.current.get(valeur)?.focus();
  }

  function applyProfil(p: Profil) {
    setProfil(p);
    setForm({
      nom: p.nom ?? "",
      niveau: p.niveau ?? "",
      classe: p.classe ?? "",
      etablissement: p.etablissement ?? "",
    });
  }

  async function refresh() {
    try {
      applyProfil(await api.get<Profil>("/api/me/profil"));
      if (onglet === "notes") setNotes(await api.get<Note[]>("/api/me/notes"));
      if (onglet === "activite") setActivite(await api.get<ActiviteItem[]>("/api/me/activite"));
      setErreurChargement(false);
    } catch {
      setErreurChargement(true);
    }
  }

  // Charge le profil au montage, et notes/activité à chaque changement
  // d'onglet. AbortController : un onglet changé (ou un démontage) pendant
  // un aller-retour annule la requête — pas de setState sur composant
  // sorti de l'arbre (É23).
  useEffect(() => {
    const ac = new AbortController();
    api
      .get<Profil>("/api/me/profil", undefined, ac.signal)
      .then(applyProfil)
      .catch(() => {
        if (!ac.signal.aborted) setErreurChargement(true);
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    if (onglet === "notes")
      api
        .get<Note[]>("/api/me/notes", undefined, ac.signal)
        .then(setNotes)
        .then(() => setErreurChargement(false))
        .catch(() => {
          if (!ac.signal.aborted) setErreurChargement(true);
        });
    if (onglet === "activite")
      api
        .get<ActiviteItem[]>("/api/me/activite", undefined, ac.signal)
        .then(setActivite)
        .then(() => setErreurChargement(false))
        .catch(() => {
          if (!ac.signal.aborted) setErreurChargement(true);
        });
    return () => ac.abort();
  }, [onglet]);

  async function saveProfil() {
    setSavingProfil(true);
    try {
      await api.put("/api/me/profil", form);
      setFormOuvert(false);
      await api
        .get<Profil>("/api/me/profil")
        .then(setProfil)
        .catch(() => setErreurChargement(true));
    } catch {
      // Avant : try/finally sans catch — un échec laissait la modale
      // ouverte sans aucun retour.
      showToast("Le profil n'a pas pu être enregistré — réessaie.", "error");
    } finally {
      setSavingProfil(false);
    }
  }

  function cancel(subId: string) {
    setConfirmation({
      titre: "Annuler cet abonnement ?",
      message: "L'accès sera révoqué immédiatement.",
      tone: "danger",
      action: async () => {
        try {
          await api.post(`/api/subscriptions/${subId}/cancel`);
          await refresh();
        } catch {
          showToast("L'annulation a échoué — réessaie.", "error");
        }
      },
    });
  }

  function deleteNote(id: string) {
    setConfirmation({
      titre: "Supprimer cette note ?",
      message: "Supprimer définitivement cette note ?",
      tone: "danger",
      action: async () => {
        try {
          await api.del(`/api/me/notes/${id}`);
          setNotes((prev) => prev.filter((n) => n.id !== id));
        } catch {
          showToast("La note n'a pas pu être supprimée — réessaie.", "error");
        }
      },
    });
  }

  async function saveConsentement(ia: boolean, notesOk: boolean) {
    setSavingConsent(true);
    try {
      await api.put("/api/me/consentement", { partage_conversations_ia: ia, partage_notes: notesOk });
      await refreshConsentement();
      showToast("Choix de confidentialité mis à jour.", "success");
    } catch {
      showToast("Le choix n'a pas pu être enregistré — réessaie.", "error");
    } finally {
      setSavingConsent(false);
    }
  }

  if (!profil)
    return erreurChargement ? (
      <div className="space-y-6">
        <ErreurChargement onReessayer={refresh} />
      </div>
    ) : (
      <div role="status" aria-busy="true" className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <div className="space-y-4">
          <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-6">
            <div className="flex items-center gap-4">
              <Skeleton className="h-14 w-14 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
            <Skeleton className="mt-3 h-3 w-1/3" />
          </div>
        </div>
        <div className="space-y-3">
          <Skeleton className="h-10 w-48 rounded-full" />
          <div className="h-28 rounded-lg border border-ink-soft/15 bg-paper-raised" />
        </div>
      </div>
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      {/* Colonne identité/résumé (sticky sur lg) : avatar, nom, classe,
          statut d'abonnement, dépense — et infos étendues. */}
      <aside className="h-fit lg:sticky lg:top-24">
      <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-6">
        <div className="flex items-center gap-4">
          <div
            aria-hidden="true"
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-ink font-mono-tag text-lg font-semibold text-paper"
          >
            {getInitials(profil.nom)}
          </div>
          <div className="min-w-0">
            <h1 className="font-serif-brand text-2xl">{profil.nom}</h1>
            <p className="text-sm text-ink-soft">{profil.email}</p>
          </div>
        </div>
        {profil.abonnements.length > 0 ? (
          <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-valide px-3 py-1 font-mono-tag text-[10px] text-paper">
            <CheckCircle2 size={11} strokeWidth={2} aria-hidden="true" />
            {profil.abonnements.length} abonnement{profil.abonnements.length > 1 ? "s" : ""} actif
            {profil.abonnements.length > 1 ? "s" : ""}
          </span>
        ) : null}
        <p className="mt-3 text-sm text-slate">
          Membre depuis le {new Date(profil.membre_depuis).toLocaleDateString("fr-FR")}
        </p>
        <p className="mt-1 text-sm text-slate">
          Total dépensé : {profil.total_depense_fcfa} FCFA
        </p>

        {/* Infos étendues (optionnelles) : niveau, classe, établissement. */}
        {formOuvert ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveProfil();
            }}
            className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2"
          >
            <label className="block">
              <span className="mb-1 block font-mono-tag text-[10px] text-ink-soft">Nom</span>
              <input
                value={form.nom}
                onChange={(e) => setForm((f) => ({ ...f, nom: e.target.value }))}
                className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-mono-tag text-[10px] text-ink-soft">Établissement</span>
              <input
                value={form.etablissement}
                onChange={(e) => setForm((f) => ({ ...f, etablissement: e.target.value }))}
                placeholder="ex. Collège/CUSS de Yaoundé"
                className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-mono-tag text-[10px] text-ink-soft">Niveau</span>
              <select
                value={form.niveau}
                onChange={(e) => setForm((f) => ({ ...f, niveau: e.target.value }))}
                className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
              >
                <option value="">—</option>
                {NIVEAUX.map((n) => (
                  <option key={n.code} value={n.code}>
                    {n.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block font-mono-tag text-[10px] text-ink-soft">Classe</span>
              <select
                value={form.classe}
                onChange={(e) => setForm((f) => ({ ...f, classe: e.target.value }))}
                className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
              >
                <option value="">—</option>
                {CLASSES_SECONDAIRE.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="col-span-2 flex gap-2">
              <button
                type="submit"
                disabled={savingProfil}
                className="min-h-[44px] rounded-full bg-ink px-5 text-sm font-medium text-paper disabled:opacity-50"
              >
                {savingProfil ? "Enregistrement…" : "Enregistrer"}
              </button>
              <button
                type="button"
                onClick={() => setFormOuvert(false)}
                className="min-h-[44px] rounded-full border border-ink-soft/25 px-4 text-sm text-ink-soft"
              >
                Annuler
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            {profil.niveau && <span className="font-mono-tag text-[10px] text-slate">NIVEAU {profil.niveau}</span>}
            {profil.classe && (
              <span className="rounded-full border border-ink-soft/25 px-2.5 py-1 text-xs">
                {classeLabel(profil.classe)}
              </span>
            )}
            {profil.etablissement && <span className="text-xs text-ink-soft">{profil.etablissement}</span>}
            <button
              type="button"
              onClick={() => setFormOuvert(true)}
              className="ml-auto flex min-h-[44px] items-center gap-1.5 rounded-full border border-ink-soft/25 px-3 text-xs text-ink-soft hover:border-highlight/50"
            >
              <Pencil size={12} strokeWidth={1.75} aria-hidden="true" />
              {profil.classe || profil.etablissement ? "Modifier" : "Compléter mes infos"}
            </button>
          </div>
        )}

        <button
          onClick={logout}
          className="mt-4 min-h-[44px] rounded-full border border-correction/40 px-5 text-sm font-medium text-correction"
        >
          Se déconnecter
        </button>
      </div>
      </aside>

      {/* Colonne principale : onglets abonnements / notes / activité /
          confidentialité, puis le panneau correspondant. */}
      <section className="min-w-0 space-y-6">
      {/* Onglets : abonnements / notes / activité / confidentialité */}
      {erreurChargement && <ErreurChargement onReessayer={refresh} />}
      <div
        role="tablist"
        aria-label="Sections du profil"
        className="flex w-fit flex-wrap gap-1 rounded-full border border-ink-soft/20 p-1 font-mono-tag text-[10px]"
      >
        {ONGLETS_PROFIL.map(([v, label]) => (
          <button
            key={v}
            id={`onglet-${v}`}
            type="button"
            role="tab"
            aria-selected={onglet === v}
            aria-controls={`panneau-${v}`}
            tabIndex={onglet === v ? 0 : -1}
            ref={(el) => {
              if (el) tabRefs.current.set(v, el);
              else tabRefs.current.delete(v);
            }}
            onClick={() => setOnglet(v)}
            onKeyDown={onTabKeyDown}
            className={`min-h-[44px] rounded-full px-4 py-1.5 ${onglet === v ? "bg-ink text-paper" : "text-ink-soft"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        key={onglet}
        id={`panneau-${onglet}`}
        role="tabpanel"
        aria-labelledby={`onglet-${onglet}`}
      >

      {onglet === "abonnements" && <PanneauAbonnements abonnements={profil.abonnements} onAnnuler={cancel} />}

      {onglet === "notes" && (
        <PanneauNotes notes={notes} onEditer={setNoteEdition} onSupprimer={deleteNote} />
      )}

      {onglet === "activite" && <PanneauActivite activite={activite} />}

      {onglet === "donnees" && user && (
        <PanneauDonnees
          user={user}
          consentIa={consentIa}
          consentNotes={consentNotes}
          onConsentIa={setConsentIa}
          onConsentNotes={setConsentNotes}
          savingConsent={savingConsent}
          onSauver={() => saveConsentement(consentIa, consentNotes)}
        />
      )}
      </div>
      </section>

      {noteEdition && (
        <NoteEditor
          epreuveId={noteEdition.epreuve_id}
          note={noteEdition}
          onClose={() => setNoteEdition(null)}
          onSaved={() =>
            api
              .get<Note[]>("/api/me/notes")
              .then(setNotes)
              .catch(() => setErreurChargement(true))
          }
        />
      )}

      {confirmation && (
        <ConfirmDialog
          tone={confirmation.tone}
          title={confirmation.titre}
          message={confirmation.message}
          onConfirm={confirmation.action}
          onClose={() => setConfirmation(null)}
        />
      )}
    </div>
  );
}

/** Pastille de portée d'un abonnement : icône + libellé + valeur couverte. */
function PuceAbonnement({
  icone: Icon,
  label,
  valeur,
}: {
  icone: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  label: string;
  valeur: string;
}) {
  return (
    <span
      title={`${label} : ${valeur}`}
      className="flex items-center gap-1.5 rounded-full border border-ink-soft/20 bg-paper px-2.5 py-1 text-xs text-ink-soft"
    >
      <Icon size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-highlight-text" />
      <span className="font-mono-tag text-[10px] text-slate">{label.toUpperCase()}</span>
      <span className="max-w-[180px] truncate font-medium text-ink">{valeur}</span>
    </span>
  );
}

/** Bandeau d'erreur de chargement, avec bouton Réessayer. */
function ErreurChargement({ onReessayer }: { onReessayer: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-correction/30 bg-correction-soft/40 p-4 text-sm"
    >
      <p className="font-medium text-ink">Le chargement a échoué.</p>
      <p className="mt-1 text-ink-soft">Vérifie ta connexion puis réessaie.</p>
      <button
        type="button"
        onClick={onReessayer}
        className="mt-3 min-h-[44px] rounded-full border border-correction/40 px-5 text-sm font-medium text-correction hover:bg-correction-soft/40"
      >
        Réessayer
      </button>
    </div>
  );
}

/** Panneau « Abonnements » : liste des abonnements actifs avec fenêtre de
 * validité et portée. Extrait de ProfilePage (É20) — pur affichage,
 * l'annulation (bouton en bas de carte) reste gérée par la page via
 * `onAnnuler` (ConfirmDialog). */
function PanneauAbonnements({
  abonnements,
  onAnnuler,
}: {
  abonnements: SubscriptionOut[];
  onAnnuler: (id: string) => void;
}) {
  if (abonnements.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-ink-soft/25 bg-paper-raised p-6 text-center">
        <p className="text-sm text-ink-soft">Aucun abonnement actif pour l'instant.</p>
        <Link
          to="/abonnement"
          className="mt-3 inline-flex min-h-[44px] items-center rounded-full bg-ink px-5 text-sm font-medium text-paper hover:opacity-90"
        >
          Découvrir les forfaits
        </Link>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {abonnements.map((s) => {
        // Fenêtre de validité : jours restants + progression (bornée 0-100).
        const debut = new Date(s.start_date).getTime();
        const fin = new Date(s.end_date).getTime();
        const maintenant = Date.now();
        const joursRestants = Math.max(0, Math.ceil((fin - maintenant) / 86_400_000));
        const progression = Math.min(100, Math.max(0, ((maintenant - debut) / Math.max(1, fin - debut)) * 100));
        const expireBientot = joursRestants <= 14;
        return (
          <div key={s.id} className="overflow-hidden rounded-lg border border-ink-soft/15 bg-paper-raised shadow-sm">
            {/* Bandeau : portée + statut */}
            <div className="flex flex-wrap items-center justify-between gap-2 bg-highlight-soft/60 px-4 py-3">
              <div className="min-w-0">
                <p className="font-mono-tag text-[10px] text-ink-soft">ABONNEMENT ACTIF</p>
                <p className="truncate font-serif-brand text-lg leading-tight">{s.scope_label}</p>
              </div>
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-valide px-2.5 py-1 font-mono-tag text-[10px] text-paper">
                <CheckCircle2 size={11} strokeWidth={2} aria-hidden="true" />
                Active
              </span>
            </div>

            <div className="p-4">
              {/* Validité : jours restants + barre de progression de la période */}
              <div>
                <div className="flex items-baseline justify-between text-xs">
                  <span className={expireBientot ? "font-medium text-correction" : "font-medium text-ink"}>
                    {joursRestants > 0 ? `${joursRestants} jour${joursRestants > 1 ? "s" : ""} restant${joursRestants > 1 ? "s" : ""}` : "Expire aujourd'hui"}
                  </span>
                  <span className="text-slate">jusqu'au {new Date(s.end_date).toLocaleDateString("fr-FR")}</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-soft/15" role="presentation">
                  <div
                    className={`h-full rounded-full ${expireBientot ? "bg-correction" : "bg-valide"}`}
                    style={{ width: `${progression}%` }}
                  />
                </div>
              </div>

              {/* Portée en pastilles : chaque dimension couverte, lisible d'un coup d'œil */}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {s.epreuve_label ? (
                  <PuceAbonnement icone={FileText} label="Épreuve" valeur={s.epreuve_label} />
                ) : (
                  <>
                    <PuceAbonnement icone={GraduationCap} label="Classe" valeur={classeLabel(s.classe)} />
                    <PuceAbonnement icone={GraduationCap} label="Série" valeur={s.filiere} />
                    {s.matiere !== "ALL" && <PuceAbonnement icone={BookOpen} label="Matière" valeur={s.matiere} />}
                    {s.annee !== "ALL" && <PuceAbonnement icone={Calendar} label="Année" valeur={s.annee} />}
                  </>
                )}
              </div>

              {/* Ce que ça débloque, mis en avant */}
              <div className="mt-3 flex items-center gap-3 rounded-lg bg-paper px-4 py-3">
                <span className="font-serif-brand text-3xl text-ink">{s.epreuves_couvertes}</span>
                <span className="text-xs text-ink-soft">
                  épreuve{s.epreuves_couvertes > 1 ? "s" : ""} débloquée
                  {s.epreuves_couvertes > 1 ? "s" : ""} dans le catalogue
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-ink-soft/20 pt-3">
                <p className="font-mono-tag text-[10px] text-slate">
                  Souscrite le {new Date(s.start_date).toLocaleDateString("fr-FR")}
                </p>
                <button
                  onClick={() => onAnnuler(s.id)}
                  className="min-h-[44px] rounded-full border border-correction/40 px-4 text-xs font-medium text-correction hover:bg-correction-soft/40"
                >
                  Annuler cet abonnement
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Panneau « Mes notes » : liste des notes personnelles + actions
 * modifier/supprimer. Extrait de ProfilePage (É20) — `onEditer` ouvre le
 * NoteEditor, `onSupprimer` passe par la confirmation de la page. */
function PanneauNotes({
  notes,
  onEditer,
  onSupprimer,
}: {
  notes: Note[];
  onEditer: (n: Note) => void;
  onSupprimer: (id: string) => void;
}) {
  if (notes.length === 0) {
    return (
      <p className="text-sm text-slate">
        Aucune note pour l'instant — sélectionne un passage dans une épreuve et clique « Prendre une note ».
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {notes.map((n) => (
        <div key={n.id} className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="font-serif-brand text-base">
              {n.matiere ? `${n.matiere} — ${n.evaluation} ${n.annee}` : "Note personnelle"}
            </p>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => onEditer(n)}
                aria-label="Modifier la note"
                title="Modifier"
                className="relative p-1.5 text-ink-soft hover:text-ink after:absolute after:-inset-[9px] after:rounded-full after:content-['']"
              >
                <Edit3 size={15} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => onSupprimer(n.id)}
                aria-label="Supprimer la note"
                title="Supprimer"
                className="relative p-1.5 text-ink-soft hover:text-correction after:absolute after:-inset-[9px] after:rounded-full after:content-['']"
              >
                <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          </div>
          {n.contexte_extrait.trim() && (
            <p className="mt-1 line-clamp-2 rounded border-l-4 border-highlight bg-highlight-soft/40 px-2 py-1 text-xs text-ink-soft">
              {n.contexte_extrait.replace(/\s+/g, " ")}
            </p>
          )}
          <p className="mt-2 line-clamp-3 text-sm text-ink-soft">{n.contenu.replace(/\s+/g, " ")}</p>
          <p className="mt-2 font-mono-tag text-[10px] text-slate">
            Modifiée {formatRelativeTime(n.updated_at)}
            {n.epreuve_id && (
              <>
                {" · "}
                <Link to={`/epreuve/${n.epreuve_id}`} className="underline hover:text-ink">
                  ouvrir l'épreuve
                </Link>
              </>
            )}
          </p>
        </div>
      ))}
    </div>
  );
}

/** Panneau « Activité » : journal chronologique des actions (consultations,
 * abonnements, discussions IA…). Les items reliés à une épreuve ouvrent le
 * lecteur (et l'onglet de discussion le cas échéant). Extrait de
 * ProfilePage (É20). */
function PanneauActivite({ activite }: { activite: ActiviteItem[] }) {
  if (activite.length === 0) {
    return <p className="text-sm text-slate">Aucune activité enregistrée.</p>;
  }
  return (
    <div className="space-y-1">
      {activite.map((a, i) => {
        const Icone = ICONE_ACTIVITE[a.type] ?? Activity;
        // Les items reliés à une épreuve ouvrent le lecteur ; une
        // discussion IA rouvre en plus SON onglet (?conv=).
        const contenu = (
          <>
            <Icone size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-soft" />
            <p className="min-w-0 flex-1 truncate text-sm">{a.libelle}</p>
            <p className="shrink-0 font-mono-tag text-[10px] text-slate">{formatRelativeTime(a.date)}</p>
          </>
        );
        const base = "flex items-center gap-3 rounded-lg border border-ink-soft/10 bg-paper-raised px-3 py-2";
        if (a.epreuve_id) {
          const cible = a.conversation_id
            ? `/epreuve/${a.epreuve_id}?conv=${a.conversation_id}`
            : `/epreuve/${a.epreuve_id}`;
          return (
            <Link key={i} to={cible} className={`${base} transition-colors hover:border-highlight/50 hover:bg-highlight-soft/40 focus-visible:border-highlight/50`}>
              {contenu}
            </Link>
          );
        }
        return (
          <div key={i} className={base}>
            {contenu}
          </div>
        );
      })}
    </div>
  );
}

/** Panneau « Confidentialité » : réglages de stockage (IA, notes) avec
 * sauvegarde explicite. Les choix restent locaux jusqu'au clic
 * « Enregistrer mes choix » — la page orchestre la mise à jour compte. */
function PanneauDonnees({
  user,
  consentIa,
  consentNotes,
  onConsentIa,
  onConsentNotes,
  savingConsent,
  onSauver,
}: {
  user: User;
  consentIa: boolean;
  consentNotes: boolean;
  onConsentIa: (v: boolean) => void;
  onConsentNotes: (v: boolean) => void;
  savingConsent: boolean;
  onSauver: () => void;
}) {
  const choixModifies =
    consentIa !== (user.consent_ia !== false) || consentNotes !== (user.consent_notes !== false);
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
        <p className="flex items-center gap-2 font-serif-brand text-base">
          <Database size={16} strokeWidth={1.75} aria-hidden="true" className="text-highlight-text" />
          Mes données et confidentialité
        </p>
        <p className="mt-1 text-xs text-ink-soft">
          Tu décides de ce qui est conservé sur nos serveurs. Un refus est effectif
          immédiatement ; tu peux changer d'avis ici à tout moment.
        </p>
        <div className="mt-3 space-y-2">
          <label className="flex cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={consentIa}
              onChange={(e) => onConsentIa(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-highlight)]"
            />
            Stocker mes conversations IA (refus = discussions éphémères, rien n'est enregistré)
          </label>
          <label className="flex cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={consentNotes}
              onChange={(e) => onConsentNotes(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-highlight)]"
            />
            Stocker mes notes personnelles (refus = la prise de note est masquée)
          </label>
        </div>
        {choixModifies && (
          <button
            type="button"
            disabled={savingConsent}
            onClick={onSauver}
            className="mt-3 min-h-[44px] rounded-full bg-ink px-4 text-xs font-medium text-paper disabled:opacity-50"
          >
            {savingConsent ? "Enregistrement…" : "Enregistrer mes choix"}
          </button>
        )}
      </div>
      <p className="px-1 text-xs text-slate">
        Ta demande de suppression de compte et de données peut être adressée à l'équipe
        depuis l'adresse {user.email}.
      </p>
    </div>
  );
}
