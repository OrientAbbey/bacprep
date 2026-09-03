import { Check, FileUp, Plus, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError, resolveMediaUrl } from "../api/client";
import { ImportJob } from "../api/types";
import { MarkdownContent } from "../components/MarkdownContent";
import { useToast } from "../components/Toast";
import { CLASSES_SECONDAIRE, classeLabel } from "../lib/referentiel";

const NIVEAUX = [
  { code: "SECONDAIRE", label: "Secondaire" },
  { code: "PRIMAIRE", label: "Primaire (réservé)" },
];

// Référentiel indicatif — miroir de backend/app/core/referentiel.py
const EVALUATIONS = [
  "CEP", "BEPC", "PROBATOIRE", "BAC", "SEQUENCE 1", "SEQUENCE 2", "SEQUENCE 3",
  "COMPOSITION TRIMESTRIELLE", "EXAMEN BLANC", "CONCOURS", "AUTRE",
];
const SERIES_CONNUES = ["A", "C", "D", "E", "TI", "F", "G", "ESP"];

interface AdminEpreuveSummary {
  id: string;
  matiere: string;
  annee: string;
  classe: string;
  evaluation: string;
  filieres: string[];
  statut: string;
  gratuit: boolean;
  corrige_disponible: boolean;
}

interface Asset {
  id: string;
  cible: "sujet" | "corrige";
  format: "md" | "image";
  filename: string;
  url: string;
}

interface EpreuveForm {
  id?: string;
  niveau: string;
  classe: string;
  evaluation: string;
  matiere: string;
  annee: string;
  session: string;
  duree: string;
  coefficient: string;
  gratuit: boolean;
  filieres: string[];
  contenu_markdown: string;
  corrige_markdown: string;
  assets: Asset[];
}

const EMPTY_FORM: EpreuveForm = {
  niveau: "SECONDAIRE",
  classe: "terminale",
  evaluation: "BAC",
  matiere: "",
  annee: "",
  session: "",
  duree: "",
  coefficient: "",
  gratuit: false,
  filieres: [],
  contenu_markdown: "",
  corrige_markdown: "",
  assets: [],
};

const SIDEBAR_LIMIT = 30;

function authHeaders(token: string): Record<string, string> {
  return { "X-Admin-Session": token };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Retire la première occurrence d'une balise `![...](url)` référençant
 * cette URL précise, quel que soit le texte de légende (l'admin a pu le
 * modifier depuis l'insertion automatique) — utilisé quand une image est
 * supprimée, pour garder le Markdown cohérent avec les fichiers restants. */
function removeImageTag(markdown: string, url: string): string {
  const re = new RegExp(`!\\[[^\\]]*\\]\\(${escapeRegExp(url)}\\)\\n?`, "g");
  return markdown.replace(re, "");
}

export function AdminPage() {
  const { showToast } = useToast();
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem("admin_session"));
  const [email, setEmail] = useState("");
  const [loginToken, setLoginToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [blocker, setBlocker] = useState<{ message: string; active_email: string } | null>(null);

  // Onglets : gestion des épreuves / import massif
  const [tab, setTab] = useState<"epreuves" | "import">("epreuves");

  const [epreuves, setEpreuves] = useState<AdminEpreuveSummary[]>([]);
  const [search, setSearch] = useState("");
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [form, setForm] = useState<EpreuveForm>(EMPTY_FORM);
  const [sujetPreview, setSujetPreview] = useState(false);
  const [corrigePreview, setCorrigePreview] = useState(false);

  /**
   * Charge la liste des épreuves (limitée à SIDEBAR_LIMIT, filtrable par
   * recherche — voir `search`) et les statistiques du tableau de bord.
   */
  async function loadAll(t: string, searchTerm: string) {
    try {
      const params = new URLSearchParams({ limit: String(SIDEBAR_LIMIT) });
      if (searchTerm.trim()) params.set("q", searchTerm.trim());
      const list = await api.get<AdminEpreuveSummary[]>(`/api/admin/epreuves?${params}`, authHeaders(t));
      setEpreuves(list);
      const s = await api.get<Record<string, unknown>>("/api/admin/stats", authHeaders(t));
      setStats(s);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setToken(null);
        sessionStorage.removeItem("admin_session");
      }
    }
  }

  // Recharge la liste après connexion, et à chaque frappe dans la
  // recherche (avec un léger anti-rebond pour ne pas spammer l'API).
  useEffect(() => {
    if (!token) return;
    const timer = setTimeout(() => loadAll(token, search), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, search]);

  async function login(force = false) {
    setError(null);
    setBlocker(null);
    try {
      const res = await api.post<{ session_token: string; email: string }>("/api/admin/login", {
        email,
        token: loginToken,
        force,
      });
      sessionStorage.setItem("admin_session", res.session_token);
      setToken(res.session_token);
      showToast(`Connecté en tant que ${res.email}.`, "success");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setBlocker(err.detail as { message: string; active_email: string });
      } else {
        setError("Connexion refusée — vérifie l'e-mail et le jeton.");
      }
    }
  }

  function onLoginSubmit(e: React.FormEvent) {
    e.preventDefault();
    login(false);
  }

  async function logoutAdmin() {
    if (token) await api.post("/api/admin/logout", undefined, authHeaders(token));
    sessionStorage.removeItem("admin_session");
    setToken(null);
    showToast("Déconnexion admin réussie.", "info");
  }

  /** Charge le détail complet d'une épreuve (métadonnées + contenu chargé
   * depuis le stockage + fichiers) dans le formulaire d'édition. */
  async function fetchDetail(id: string) {
    if (!token) return;
    const detail = await api.get<any>(`/api/admin/epreuves/${id}`, authHeaders(token));
    setForm({
      id: detail.id,
      niveau: detail.niveau || "SECONDAIRE",
      classe: detail.classe || "terminale",
      evaluation: detail.evaluation || "BAC",
      matiere: detail.matiere,
      annee: detail.annee,
      session: detail.session || "",
      duree: detail.duree || "",
      coefficient: detail.coefficient || "",
      gratuit: detail.gratuit,
      filieres: detail.filieres || [],
      contenu_markdown: detail.contenu_markdown || "",
      corrige_markdown: detail.corrige_markdown || "",
      assets: detail.assets || [],
    });
  }

  function toggleSerie(serie: string) {
    setForm((f) => ({
      ...f,
      filieres: f.filieres.includes(serie)
        ? f.filieres.filter((s) => s !== serie)
        : [...f.filieres, serie],
    }));
  }

  async function save() {
    if (!token) return;
    const payload = {
      niveau: form.niveau,
      classe: form.classe,
      evaluation: form.evaluation,
      matiere: form.matiere,
      annee: form.annee,
      session: form.session,
      duree: form.duree || null,
      coefficient: form.coefficient || null,
      gratuit: form.gratuit,
      filieres: form.filieres,
      contenu_markdown: form.contenu_markdown,
      corrige_markdown: form.corrige_markdown,
    };
    try {
      if (form.id) {
        await api.put(`/api/admin/epreuves/${form.id}`, payload, authHeaders(token));
        showToast("Épreuve mise à jour.", "success");
      } else {
        const res = await api.post<{ id: string }>("/api/admin/epreuves", payload, authHeaders(token));
        setForm((f) => ({ ...f, id: res.id }));
        showToast("Épreuve créée (brouillon).", "success");
      }
      loadAll(token, search);
    } catch {
      showToast("Échec de l'enregistrement — vérifie les champs.", "error");
    }
  }

  function onEditFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    save();
  }

  async function publish() {
    if (!token || !form.id) return;
    try {
      await api.post(`/api/admin/epreuves/${form.id}/publish`, undefined, authHeaders(token));
      showToast("Épreuve publiée.", "success");
      loadAll(token, search);
    } catch {
      showToast("Publication refusée — sujet et au moins une série sont requis.", "error");
    }
  }

  async function unpublish() {
    if (!token || !form.id) return;
    await api.post(`/api/admin/epreuves/${form.id}/unpublish`, undefined, authHeaders(token));
    showToast("Épreuve dépubliée.", "info");
    loadAll(token, search);
  }

  async function remove(id: string) {
    if (!token || !confirm("Supprimer définitivement cette épreuve (et son corrigé, ses images) ?")) return;
    await api.del(`/api/admin/epreuves/${id}`, authHeaders(token));
    setForm(EMPTY_FORM);
    showToast("Épreuve supprimée.", "info");
    loadAll(token, search);
  }

  async function uploadImage(file: File, cible: "sujet" | "corrige") {
    if (!token || !form.id) {
      showToast("Enregistre d'abord l'épreuve avant d'ajouter des images.", "error");
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("cible", cible);
    try {
      const asset = await api.upload<Asset>(`/api/admin/epreuves/${form.id}/images`, fd, authHeaders(token));
      if ((asset as any).doublon_de) {
        showToast(`Image identique déjà présente sur l'épreuve ${(asset as any).doublon_de}.`, "info");
      }
      const tag = `![légende](${asset.url})`;
      setForm((f) => ({
        ...f,
        assets: [...f.assets, asset],
        contenu_markdown: cible === "sujet" ? f.contenu_markdown + "\n" + tag : f.contenu_markdown,
        corrige_markdown: cible === "corrige" ? f.corrige_markdown + "\n" + tag : f.corrige_markdown,
      }));
      showToast("Image téléversée et insérée.", "success");
    } catch {
      showToast("Échec de l'upload d'image.", "error");
    }
  }

  /** Bouton "x" sur une vignette : supprime le fichier côté serveur ET
   * retire la balise Markdown correspondante du texte, pour ne pas
   * laisser un lien mort dans le sujet/corrigé. */
  async function deleteImage(asset: Asset) {
    if (!token) return;
    if (!confirm("Retirer cette image des fichiers de l'épreuve ?")) return;
    try {
      await api.del(`/api/admin/files/${asset.id}`, authHeaders(token));
      setForm((f) => ({
        ...f,
        assets: f.assets.filter((a) => a.id !== asset.id),
        contenu_markdown:
          asset.cible === "sujet" ? removeImageTag(f.contenu_markdown, asset.url) : f.contenu_markdown,
        corrige_markdown:
          asset.cible === "corrige" ? removeImageTag(f.corrige_markdown, asset.url) : f.corrige_markdown,
      }));
      showToast("Image retirée.", "success");
    } catch {
      showToast("Échec de la suppression de l'image.", "error");
    }
  }

  /** Bouton "+" sur une vignette : (ré)insère la balise Markdown de cette
   * image dans le texte correspondant (utile si l'admin l'a retirée
   * manuellement en éditant le Markdown, sans supprimer le fichier). */
  function insertImageTag(asset: Asset) {
    const tag = `![légende](${asset.url})`;
    setForm((f) => ({
      ...f,
      contenu_markdown: asset.cible === "sujet" ? f.contenu_markdown + "\n" + tag : f.contenu_markdown,
      corrige_markdown: asset.cible === "corrige" ? f.corrige_markdown + "\n" + tag : f.corrige_markdown,
    }));
    showToast("Balise image insérée dans le texte.", "success");
  }

  if (!token) {
    return (
      <form
        onSubmit={onLoginSubmit}
        className="mx-auto max-w-sm space-y-4 rounded-lg border border-ink-soft/15 bg-paper-raised p-6"
      >
        <h1 className="font-serif-brand text-xl">Connexion administrateur</h1>
        <input
          type="email"
          placeholder="admin@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
        />
        <input
          placeholder="Jeton d'accès (voir ADMIN_TOKEN)"
          type="password"
          value={loginToken}
          onChange={(e) => setLoginToken(e.target.value)}
          className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
        />
        {error && <p className="text-sm text-correction">{error}</p>}
        {blocker && (
          <div className="space-y-2 rounded-md border border-correction/30 bg-correction-soft p-3 text-sm text-correction">
            <p>{blocker.message}</p>
            <button
              type="button"
              onClick={() => login(true)}
              className="min-h-[36px] rounded-full bg-correction px-4 text-xs font-medium text-paper"
            >
              Forcer la connexion
            </button>
          </div>
        )}
        <button type="submit" className="min-h-[44px] w-full rounded-full bg-ink text-sm font-medium text-paper">
          Se connecter
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="font-serif-brand text-2xl">Back-office</h1>
        <button
          onClick={logoutAdmin}
          className="min-h-[40px] rounded-full border border-correction/40 px-4 text-sm text-correction"
        >
          Déconnexion admin
        </button>
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Utilisateurs" value={String(stats.utilisateurs)} />
          <Stat label="Abonnements actifs" value={String(stats.abonnements_actifs)} />
          <Stat label="Revenu (FCFA)" value={String(stats.revenu_total_fcfa)} />
          <Stat label="Épreuves publiées" value={String((stats.epreuves_par_statut as any)?.publie ?? 0)} />
        </div>
      )}

      <div className="flex gap-1 rounded-full border border-ink-soft/20 p-1 font-mono-tag text-[10px] w-fit">
        <button
          onClick={() => setTab("epreuves")}
          className={`rounded-full px-4 py-1.5 ${tab === "epreuves" ? "bg-ink text-paper" : "text-ink-soft"}`}
        >
          Épreuves
        </button>
        <button
          onClick={() => setTab("import")}
          className={`rounded-full px-4 py-1.5 ${tab === "import" ? "bg-ink text-paper" : "text-ink-soft"}`}
        >
          Import massif
        </button>
      </div>

      {tab === "epreuves" ? (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <div className="space-y-2">
            <button
              onClick={() => setForm(EMPTY_FORM)}
              className="min-h-[40px] w-full rounded-full border border-ink-soft/25 text-sm"
            >
              + Nouvelle épreuve
            </button>

            <div className="relative">
              <Search
                size={15}
                strokeWidth={1.75}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate"
                aria-hidden="true"
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Rechercher une épreuve…"
                aria-label="Rechercher une épreuve par matière ou année"
                className="min-h-[40px] w-full rounded-full border border-ink-soft/25 bg-paper-raised pl-9 pr-3 text-sm"
              />
            </div>

            {epreuves.map((e) => {
              const selected = form.id === e.id;
              return (
                <button
                  key={e.id}
                  onClick={() => fetchDetail(e.id)}
                  aria-current={selected}
                  className={`block w-full rounded-lg border p-3 text-left text-sm transition-colors ${
                    selected
                      ? "border-highlight bg-highlight-soft"
                      : "border-ink-soft/15 bg-paper-raised hover:border-highlight/50 hover:bg-highlight-soft/40"
                  }`}
                >
                  <p className="font-medium">
                    {e.matiere} — {e.annee}
                  </p>
                  <p className="font-mono-tag text-[10px] text-slate">
                    {classeLabel(e.classe)} · {e.evaluation} · {e.statut} · {e.filieres.join(",")}
                  </p>
                </button>
              );
            })}
            {epreuves.length === SIDEBAR_LIMIT && (
              <p className="px-1 text-xs text-slate">
                Affichage limité aux {SIDEBAR_LIMIT} épreuves les plus récentes — affine la recherche pour en
                trouver d'autres.
              </p>
            )}
          </div>

          <form
            onSubmit={onEditFormSubmit}
            className="space-y-4 rounded-lg border border-ink-soft/15 bg-paper-raised p-5"
          >
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Niveau"
                value={form.niveau}
                onChange={(v) => setForm((f) => ({ ...f, niveau: v }))}
                options={NIVEAUX.map((n) => ({ value: n.code, label: n.label }))}
              />
              <Select
                label="Classe"
                value={form.classe}
                onChange={(v) => setForm((f) => ({ ...f, classe: v }))}
                options={CLASSES_SECONDAIRE.map((c) => ({ value: c.code, label: c.label }))}
              />
              <Select
                label="Évaluation"
                value={form.evaluation}
                onChange={(v) => setForm((f) => ({ ...f, evaluation: v }))}
                options={EVALUATIONS.map((ev) => ({ value: ev, label: ev }))}
              />
              <Field
                label="Année"
                value={form.annee}
                onChange={(v) => setForm((f) => ({ ...f, annee: v }))}
                placeholder="ex. 2024"
              />
              <Field
                label="Matière"
                value={form.matiere}
                onChange={(v) => setForm((f) => ({ ...f, matiere: v }))}
                placeholder="ex. Mathématiques"
              />
              <Field
                label="Session"
                value={form.session}
                onChange={(v) => setForm((f) => ({ ...f, session: v }))}
                placeholder="ex. Session normale"
              />
              <Field
                label="Durée"
                value={form.duree}
                onChange={(v) => setForm((f) => ({ ...f, duree: v }))}
                placeholder="ex. 4h"
              />
              <Field
                label="Coefficient"
                value={form.coefficient}
                onChange={(v) => setForm((f) => ({ ...f, coefficient: v }))}
                placeholder="ex. 5"
              />
            </div>

            {/* Séries : sélection multiple par puces (une épreuve peut couvrir
                PLUSIEURS séries) + champ libre pour une série hors référentiel. */}
            <div>
              <p className="mb-1 font-mono-tag text-[10px] text-ink-soft">Séries / filières</p>
              <div className="flex flex-wrap gap-1.5">
                {SERIES_CONNUES.map((s) => {
                  const active = form.filieres.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => toggleSerie(s)}
                      aria-pressed={active}
                      className={`flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                        active
                          ? "border-ink bg-ink text-paper"
                          : "border-ink-soft/25 text-ink-soft hover:border-highlight/50"
                      }`}
                    >
                      {active && <Check size={12} strokeWidth={2.5} aria-hidden="true" />}
                      {s}
                    </button>
                  );
                })}
                {form.filieres
                  .filter((s) => !SERIES_CONNUES.includes(s))
                  .map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => toggleSerie(s)}
                      aria-pressed
                      className="flex items-center gap-1 rounded-full border border-ink bg-ink px-3 py-1.5 text-xs text-paper"
                    >
                      <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                      {s}
                    </button>
                  ))}
              </div>
              <input
                value=""
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (v && !form.filieres.includes(v)) setForm((f) => ({ ...f, filieres: [...f.filieres, v] }));
                }}
                placeholder="Ajouter une série hors référentiel puis Entrée…"
                className="mt-2 min-h-[36px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-xs"
              />
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.gratuit}
                onChange={(e) => setForm((f) => ({ ...f, gratuit: e.target.checked }))}
              />
              Contenu gratuit de découverte
            </label>

            <ContentBlock
              title="Sujet"
              required
              markdown={form.contenu_markdown}
              preview={sujetPreview}
              onTogglePreview={() => setSujetPreview((p) => !p)}
              onChange={(v) => setForm((f) => ({ ...f, contenu_markdown: v }))}
              onUpload={(file) => uploadImage(file, "sujet")}
              assets={form.assets.filter((a) => a.cible === "sujet")}
              onDeleteImage={deleteImage}
              onInsertImage={insertImageTag}
            />

            <ContentBlock
              title="Corrigé (optionnel)"
              required={false}
              markdown={form.corrige_markdown}
              preview={corrigePreview}
              onTogglePreview={() => setCorrigePreview((p) => !p)}
              onChange={(v) => setForm((f) => ({ ...f, corrige_markdown: v }))}
              onUpload={(file) => uploadImage(file, "corrige")}
              assets={form.assets.filter((a) => a.cible === "corrige")}
              onDeleteImage={deleteImage}
              onInsertImage={insertImageTag}
            />

            <div className="flex flex-wrap gap-2 border-t border-ink-soft/10 pt-4">
              <button type="submit" className="min-h-[40px] rounded-full bg-ink px-5 text-sm text-paper">
                Enregistrer
              </button>
              {form.id && (
                <>
                  <button
                    type="button"
                    onClick={publish}
                    className="min-h-[40px] rounded-full bg-valide px-5 text-sm text-white"
                  >
                    Publier
                  </button>
                  <button
                    type="button"
                    onClick={unpublish}
                    className="min-h-[40px] rounded-full border border-ink-soft/25 px-5 text-sm"
                  >
                    Dépublier
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(form.id!)}
                    className="min-h-[40px] rounded-full border border-correction/40 px-5 text-sm text-correction"
                  >
                    Supprimer
                  </button>
                </>
              )}
            </div>
          </form>
        </div>
      ) : (
        <ImportPanel token={token} />
      )}
    </div>
  );
}

/** Zone d'import massif : upload d'un dossier compressé (.zip) organisé
 * {annee}/{classe}/{matiere}/*.md, traitement en tâche de fond par le même
 * moteur que le script CLI `python -m app.scripts.importer`, puis rapport
 * détaillé (créées, doublons, métadonnées manquantes, erreurs). */
function ImportPanel({ token }: { token: string }) {
  const { showToast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [jobs, setJobs] = useState<ImportJob[]>([]);

  async function loadJobs() {
    try {
      const list = await api.get<ImportJob[]>("/api/admin/import/jobs", authHeaders(token));
      setJobs(list);
    } catch {
      /* silencieux : la liste est un confort, pas un besoin critique */
    }
  }

  useEffect(() => {
    loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling du job en cours tant qu'il n'est pas terminé.
  useEffect(() => {
    if (!job || job.status === "done" || job.status === "error") return;
    const timer = setInterval(async () => {
      try {
        const fresh = await api.get<ImportJob>(`/api/admin/import/jobs/${job.id}`, authHeaders(token));
        setJob(fresh);
        if (fresh.status === "done" || fresh.status === "error") loadJobs();
      } catch {
        /* retente au prochain tick */
      }
    }, 1500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  async function startImport() {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api.upload<{ job_id: string }>("/api/admin/import", fd, authHeaders(token));
      setJob({
        id: res.job_id,
        filename: file.name,
        status: "pending",
        created_at: new Date().toISOString(),
        finished_at: null,
        report: {},
      });
      showToast("Import lancé — traitement en cours.", "success");
    } catch (err) {
      if (err instanceof ApiError) showToast(`Import refusé : ${JSON.stringify(err.detail)}`, "error");
      else showToast("Échec de l'envoi de l'archive.", "error");
    } finally {
      setUploading(false);
    }
  }

  const report = job?.report;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
        <h2 className="font-serif-brand text-lg">Importer un dossier d'épreuves</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Compresse un dossier organisé puis dépose l'archive. Structure attendue (tolérante) :
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md bg-paper p-3 font-mono text-xs text-ink-soft">
{`mon-dossier/
└── 2023/
    └── Terminale/
        └── Mathématiques/
            ├── bac-D-sujet.md
            ├── bac-D-corrige.md
            └── figure1.png`}
        </pre>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-ink-soft">
          <li>Uniquement des fichiers Markdown (<code>.md</code>) et des images — pas de PDF.</li>
          <li>
            Nom de fichier contenant <code>corrige</code> → corrigé, sinon sujet. La série est extraite
            du nom (<code>série D</code>, <code>bac-D</code>…).
          </li>
          <li>
            Les doublons (contenu identique) sont détectés par empreinte SHA-256 et ignorés ; les
            fichiers dont les métadonnées (année/classe/matière) sont insuffisantes sont signalés.
          </li>
          <li>Les épreuves importées arrivent en <strong>brouillon</strong> : à relire puis publier.</li>
          <li>
            Alternative en ligne de commande sur le serveur :{" "}
            <code>python -m app.scripts.importer --dir backend/data/imports</code>.
          </li>
        </ul>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="cursor-pointer">
            <span className="flex min-h-[40px] items-center gap-2 rounded-full border border-ink-soft/25 px-4 text-sm hover:border-highlight/50">
              <FileUp size={16} strokeWidth={1.75} aria-hidden="true" />
              {file ? file.name : "Choisir une archive .zip…"}
            </span>
            <input
              type="file"
              accept=".zip"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <button
            onClick={startImport}
            disabled={!file || uploading}
            className="min-h-[40px] rounded-full bg-ink px-5 text-sm text-paper disabled:opacity-50"
          >
            {uploading ? "Envoi…" : "Lancer l'import"}
          </button>
        </div>
      </div>

      {job && (
        <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
          <div className="flex items-center justify-between">
            <h3 className="font-serif-brand text-lg">
              Job <span className="font-mono-tag text-xs">{job.id.slice(0, 8)}</span> — {job.filename}
            </h3>
            <span
              className={`rounded-full px-3 py-1 font-mono-tag text-[10px] ${
                job.status === "done"
                  ? "bg-valide-soft text-valide"
                  : job.status === "error"
                  ? "bg-correction-soft text-correction"
                  : "bg-highlight-soft text-ink"
              }`}
            >
              {job.status === "pending" && "En attente…"}
              {job.status === "running" && "Traitement en cours…"}
              {job.status === "done" && "Terminé"}
              {job.status === "error" && "Erreur"}
            </span>
          </div>

          {report && (job.status === "done" || job.status === "error") && (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Fichiers analysés" value={String(report.analyses ?? 0)} />
              <Stat label="Épreuves créées" value={String(report.epreuves_creees ?? 0)} />
              <Stat label="Images importées" value={String(report.images_importees ?? 0)} />
              <Stat label="Doublons ignorés" value={String(report.doublons?.length ?? 0)} />
            </div>
          )}

          {report?.metadonnees_manquantes && report.metadonnees_manquantes.length > 0 && (
            <div className="mt-4">
              <p className="font-mono-tag text-[10px] text-correction">MÉTADONNÉES INSUFFISANTES</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-ink-soft">
                {report.metadonnees_manquantes.map((m, i) => (
                  <li key={i}>
                    <code>{m.fichier}</code> — manquant : {m.manquants.join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report?.erreurs && report.erreurs.length > 0 && (
            <div className="mt-4">
              <p className="font-mono-tag text-[10px] text-correction">ERREURS</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-ink-soft">
                {report.erreurs.map((e, i) => (
                  <li key={i}>
                    <code>{e.fichier}</code> — {e.erreur}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report?.creees && report.creees.length > 0 && (
            <div className="mt-4">
              <p className="font-mono-tag text-[10px] text-ink-soft">FICHIERS IMPORTÉS</p>
              <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5 text-xs text-ink-soft">
                {report.creees.map((c, i) => (
                  <li key={i}>
                    <code>{c.fichier}</code>
                    {c.epreuve_id ? ` → épreuve ${c.epreuve_id} (${c.cible})` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {jobs.length > 0 && (
        <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
          <h3 className="font-serif-brand text-lg">Imports précédents</h3>
          <ul className="mt-2 divide-y divide-ink-soft/10 text-sm">
            {jobs.map((j) => (
              <li key={j.id} className="flex items-center justify-between py-2">
                <span>
                  {j.filename || j.id.slice(0, 8)}{" "}
                  <span className="font-mono-tag text-[10px] text-slate">
                    {new Date(j.created_at).toLocaleString("fr-FR")}
                  </span>
                </span>
                <span
                  className={`font-mono-tag text-[10px] ${
                    j.status === "done" ? "text-valide" : j.status === "error" ? "text-correction" : "text-slate"
                  }`}
                >
                  {j.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-3">
      <p className="font-mono-tag text-[10px] text-slate">{label}</p>
      <p className="font-serif-brand text-xl">{value}</p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-1 block font-mono-tag text-[10px] text-ink-soft">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
      />
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="mb-1 block font-mono-tag text-[10px] text-ink-soft">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ContentBlock({
  title,
  required,
  markdown,
  preview,
  onTogglePreview,
  onChange,
  onUpload,
  assets,
  onDeleteImage,
  onInsertImage,
}: {
  title: string;
  required: boolean;
  markdown: string;
  preview: boolean;
  onTogglePreview: () => void;
  onChange: (v: string) => void;
  onUpload: (file: File) => void;
  assets: Asset[];
  onDeleteImage: (asset: Asset) => void;
  onInsertImage: (asset: Asset) => void;
}) {
  return (
    <div className="space-y-2 border-t border-ink-soft/10 pt-4">
      <div className="flex items-center justify-between">
        <h3 className="font-serif-brand text-lg">
          {title} {required && <span className="text-correction">*</span>}
        </h3>
        <button
          type="button"
          onClick={onTogglePreview}
          className="rounded-full border border-ink-soft/25 px-3 py-1 text-xs"
        >
          {preview ? "Texte" : "Rendu"}
        </button>
      </div>
      <p className="text-xs text-slate">
        Format attendu : titres Markdown, ancres <code>{"{#id}"}</code>, LaTeX <code>$...$</code>, tableaux
        Markdown, images <code>![légende](url)</code>.
      </p>

      {preview ? (
        <div className="max-h-[420px] overflow-y-auto rounded-md border border-ink-soft/15 p-3">
          <MarkdownContent content={markdown} variant="epreuve" />
        </div>
      ) : (
        <textarea
          value={markdown}
          onChange={(e) => onChange(e.target.value)}
          rows={10}
          className="w-full rounded-md border border-ink-soft/25 bg-paper p-3 font-mono text-sm"
        />
      )}

      <div>
        <input
          type="file"
          accept="image/*"
          className="block cursor-pointer text-sm file:mr-3 file:cursor-pointer file:rounded-full file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-paper"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(file);
            e.target.value = "";
          }}
        />
        {assets.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {assets.map((a) => (
              <div
                key={a.id}
                className="group relative h-16 w-16 overflow-hidden rounded border border-ink-soft/20 bg-paper"
              >
                <img
                  src={resolveMediaUrl(a.url)}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
                <button
                  type="button"
                  onClick={() => onDeleteImage(a)}
                  title="Retirer cette image (supprime le fichier)"
                  aria-label="Retirer cette image"
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-correction text-white shadow"
                >
                  <X size={12} strokeWidth={2.5} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => onInsertImage(a)}
                  title="Insérer la balise Markdown de cette image dans le texte"
                  aria-label="Insérer cette image dans le texte"
                  className="absolute bottom-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-valide text-white shadow"
                >
                  <Plus size={12} strokeWidth={2.5} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
