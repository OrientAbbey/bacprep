import { Ban, Check, FileUp, FileText, Plus, Search, ScrollText, Flag, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, resolveMediaUrl } from "../api/client";
import {
  AdminEpreuveCounts,
  AdminEvent,
  AdminStats,
  AdminUtilisateur,
  ImportJob,
  Signalement,
} from "../api/types";
import { MarkdownContent } from "../components/MarkdownContent";
import { useToast } from "../components/Toast";
import { formatBytes } from "../lib/format";
import { MOTIF_LABELS } from "../lib/motifs";
import { CLASSES_SECONDAIRE, NIVEAUX, classeLabel } from "../lib/referentiel";
import { formatRelativeTime } from "../lib/time";

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
  size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
  mime_type?: string;
  doublon_de?: string | null;
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
  /** Documents Markdown (sujet.md / corrige.md) — séparés des images pour
   * ne plus apparaître comme des « images rattachées » dans la galerie. */
  documents: DocumentFile[];
}

/** Document Markdown attaché au sujet ou au corrigé (liste texte, pas une
 * vignette d'image). */
interface DocumentFile {
  id: string;
  cible: "sujet" | "corrige";
  filename: string;
  size_bytes?: number | null;
  uploaded_at?: string | null;
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
  documents: [],
};

const SIDEBAR_LIMIT = 30;

function authHeaders(token: string): Record<string, string> {
  return { "X-Admin-Session": token };
}

/** 401 dans un panneau (verrou admin expiré pendant l'inactivité) : purge la
 * session locale et recharge — la page repasse par le formulaire de connexion
 * AU LIEU d'afficher une « liste vide » trompeuse. */
function purgerSessionExpiree(err: unknown): boolean {
  if (!(err instanceof ApiError && err.status === 401)) return false;
  sessionStorage.removeItem("admin_session");
  window.location.reload();
  return true;
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

  // Onglet initial lisible depuis l'URL (/admin?tab=utilisateurs) : lien
  // profond depuis le journal d'audit ou un signet — les onglets restent
  // ensuite pilotés par les boutons (pas de synchronisation bidirectionnelle
  // volontaire pour garder l'URL stable).
  const [tab, setTab] = useState<"epreuves" | "import" | "utilisateurs" | "journal" | "signalements">(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return (["epreuves", "import", "utilisateurs", "journal", "signalements"] as const).includes(
      t as never
    )
      ? (t as "epreuves" | "import" | "utilisateurs" | "journal" | "signalements")
      : "epreuves";
  });

  const [epreuves, setEpreuves] = useState<AdminEpreuveSummary[]>([]);
  const [search, setSearch] = useState("");
  const [statutFiltre, setStatutFiltre] = useState<string>("");
  const [counts, setCounts] = useState<AdminEpreuveCounts | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [form, setForm] = useState<EpreuveForm>(EMPTY_FORM);
  const [nouvelleSerie, setNouvelleSerie] = useState("");
  const [sujetPreview, setSujetPreview] = useState(false);
  const [corrigePreview, setCorrigePreview] = useState(false);

  /** Session admin expirée côté serveur (401) : purge le jeton local pour
   * repasser par le formulaire de connexion. Retourne vrai si c'était un
   * 401 — les autres erreurs restent à la charge de l'appelant. */
  function handle401(err: unknown): boolean {
    if (!(err instanceof ApiError && err.status === 401)) return false;
    setToken(null);
    sessionStorage.removeItem("admin_session");
    return true;
  }

  /**
   * Charge la liste des épreuves (limitée à SIDEBAR_LIMIT, filtrable par
   * recherche — voir `search`) et les statistiques du tableau de bord.
   */
  async function loadAll(t: string, searchTerm: string, statut = "") {
    try {
      const params = new URLSearchParams({ limit: String(SIDEBAR_LIMIT) });
      if (searchTerm.trim()) params.set("q", searchTerm.trim());
      if (statut) params.set("statut", statut);
      const list = await api.get<AdminEpreuveSummary[]>(`/api/admin/epreuves?${params}`, authHeaders(t));
      setEpreuves(list);
      const cnt = await api.get<AdminEpreuveCounts>("/api/admin/epreuves/counts", authHeaders(t));
      setCounts(cnt);
      const s = await api.get<AdminStats>("/api/admin/stats", authHeaders(t));
      setStats(s);
    } catch (err) {
      handle401(err);
    }
  }

  // Recharge la liste après connexion, et à chaque frappe dans la
  // recherche ou changement de puces de statut (avec un léger anti-rebond
  // pour ne pas spammer l'API).
  useEffect(() => {
    if (!token) return;
    const timer = setTimeout(() => loadAll(token, search, statutFiltre), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, search, statutFiltre]);

  // Battement de cœur : tant que la console est ouverte, signale au serveur
  // que l'admin est actif (l'endpoint rafraîchit le verrou). Sans lui,
  // rester immobile sur une page (tableau utilisateurs, journal) laissait
  // expirer le verrou au bout du délai configuré et les chargements
  // suivants répondaient 401 — affichés à tort comme des « listes vides ».
  // QUITTER /admin arrête les battements : le verrou expire alors après
  // ADMIN_SESSION_TIMEOUT_MINUTES (défaut 3 min), conformément au
  // comportement attendu.
  useEffect(() => {
    if (!token) return;
    const battement = setInterval(async () => {
      try {
        await api.post("/api/admin/heartbeat", undefined, authHeaders(token));
      } catch (err) {
        handle401(err);
      }
    }, 30_000);
    return () => clearInterval(battement);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

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
    try {
      const detail = await api.get<Partial<EpreuveForm> & { id: string }>(
        `/api/admin/epreuves/${id}`,
        authHeaders(token)
      );
      setForm({
        id: detail.id,
        niveau: detail.niveau || "SECONDAIRE",
        classe: detail.classe || "terminale",
        evaluation: detail.evaluation || "BAC",
        matiere: detail.matiere || "",
        annee: detail.annee || "",
        session: detail.session || "",
        duree: detail.duree || "",
        coefficient: detail.coefficient || "",
        gratuit: Boolean(detail.gratuit),
        filieres: detail.filieres || [],
        contenu_markdown: detail.contenu_markdown || "",
        corrige_markdown: detail.corrige_markdown || "",
        assets: detail.assets || [],
        documents: (detail as unknown as { documents?: DocumentFile[] }).documents || [],
      });
    } catch (err) {
      if (!handle401(err)) {
        showToast("Le détail de l'épreuve n'a pas pu être chargé.", "error");
      }
    }
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
    try {
      await api.post(`/api/admin/epreuves/${form.id}/unpublish`, undefined, authHeaders(token));
      showToast("Épreuve dépubliée.", "info");
      loadAll(token, search);
    } catch (err) {
      if (!handle401(err)) {
        showToast("La dépublication a échoué — réessaie.", "error");
      }
    }
  }

  async function remove(id: string) {
    if (!token || !confirm("Supprimer définitivement cette épreuve (et son corrigé, ses images) ?")) return;
    try {
      await api.del(`/api/admin/epreuves/${id}`, authHeaders(token));
      setForm(EMPTY_FORM);
      showToast("Épreuve supprimée.", "info");
      loadAll(token, search);
    } catch (err) {
      if (!handle401(err)) {
        showToast("La suppression a échoué — réessaie.", "error");
      }
    }
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
      if (asset.doublon_de) {
        showToast(`Image identique déjà présente sur l'épreuve ${asset.doublon_de}.`, "info");
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

  /** Supprime un DOCUMENT (sujet.md/corrige.md) de la liste — le contenu
   * de la cible est perdu, confirmation explicite. */
  async function deleteDocument(doc: DocumentFile) {
    if (!token) return;
    if (!confirm(`Supprimer le document « ${doc.filename} » (${doc.cible}) ? Le contenu correspondant sera perdu.`)) return;
    try {
      await api.del(`/api/admin/files/${doc.id}`, authHeaders(token));
      setForm((f) => ({ ...f, documents: f.documents.filter((d) => d.id !== doc.id) }));
      showToast("Document supprimé.", "success");
    } catch {
      showToast("Échec de la suppression du document.", "error");
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
        <div className="space-y-3">
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
      )}

      <div className="flex flex-wrap gap-1 rounded-full border border-ink-soft/20 p-1 font-mono-tag text-[10px] w-fit">
        {(
          [
            ["epreuves", "Épreuves"],
            ["import", "Import massif"],
            ["utilisateurs", `Utilisateurs${stats?.utilisateurs ? ` (${stats.utilisateurs})` : ""}`],
            ["signalements", `Signalements${stats?.signalements_ouverts ? ` (${stats.signalements_ouverts})` : ""}`],
            ["journal", "Journal"],
          ] as [typeof tab, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setTab(v)}
            aria-pressed={tab === v}
            className={`rounded-full px-4 py-1.5 ${tab === v ? "bg-ink text-paper" : "text-ink-soft"}`}
          >
            {label}
          </button>
        ))}
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

            {/* Puces de statut avec compteurs : cadrent la liste sans tout
                charger (« Tous (180) », « Brouillon (50) »...). */}
            {counts && (
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["", "Tous", counts.tous],
                    ["publie", "Publiées", counts.publie],
                    ["a_reviser", "À réviser", counts.a_reviser],
                    ["brouillon", "Brouillons", counts.brouillon],
                  ] as [string, string, number][]
                ).map(([value, label, count]) => (
                  <button
                    key={value || "tous"}
                    type="button"
                    onClick={() => setStatutFiltre(value)}
                    aria-pressed={statutFiltre === value}
                    className={`rounded-full border px-2.5 py-1 font-mono-tag text-[10px] transition-colors ${
                      statutFiltre === value
                        ? "border-ink bg-ink text-paper"
                        : "border-ink-soft/20 text-ink-soft hover:border-highlight/50"
                    }`}
                  >
                    {label} ({count})
                  </button>
                ))}
              </div>
            )}

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
                value={nouvelleSerie}
                onChange={(e) => setNouvelleSerie(e.target.value)}
                onKeyDown={(e) => {
                  // Bug corrigé : l'input était contrôlé avec value="" —
                  // chaque caractère tapé était ajouté comme série (taper
                  // "ESP" créait "E", "S", "P") et le placeholder promettait
                  // Entrée sans la gérer.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const v = nouvelleSerie.trim();
                    if (v && !form.filieres.includes(v)) {
                      setForm((f) => ({ ...f, filieres: [...f.filieres, v] }));
                    }
                    setNouvelleSerie("");
                  }
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
              documents={form.documents.filter((d) => d.cible === "sujet")}
              onDeleteImage={deleteImage}
              onInsertImage={insertImageTag}
              onDeleteDocument={deleteDocument}
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
              documents={form.documents.filter((d) => d.cible === "corrige")}
              onDeleteImage={deleteImage}
              onInsertImage={insertImageTag}
              onDeleteDocument={deleteDocument}
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
                    className="min-h-[40px] rounded-full bg-valide px-5 text-sm text-paper"
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
      ) : tab === "import" ? (
        <ImportPanel token={token} />
      ) : tab === "utilisateurs" ? (
        <UtilisateursPanel token={token} />
      ) : tab === "signalements" ? (
        <SignalementsPanel token={token} />
      ) : (
        <JournalPanel
          token={token}
          onOuvrirEpreuve={(id) => {
            setTab("epreuves");
            fetchDetail(id);
          }}
        />
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
  const logsRef = useRef<HTMLPreElement>(null);

  // Défilement automatique de la console de logs vers la dernière ligne
  // tant que le job est en cours.
  useEffect(() => {
    if (job?.status === "pending" || job?.status === "running") {
      logsRef.current?.scrollTo({ top: logsRef.current.scrollHeight });
    }
  }, [job?.logs?.length, job?.status]);

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
        logs: [],
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

          {/* Console de journal en direct : lignes accumulées par la tâche
              de fond (polling 1,5 s), affichées pendant l'exécution ET
              conservées après la fin pour relecture. Défilement auto vers
              la dernière ligne tant que le job tourne. */}
          {job.logs && job.logs.length > 0 && (
            <pre
              ref={logsRef}
              className="mt-4 max-h-48 overflow-y-auto rounded-md bg-margin p-3 font-mono text-xs leading-relaxed text-margin-text"
              aria-label="Journal d'exécution de l'import"
            >
              {job.logs.map((ligne, i) => (
                <span key={i} className={ligne.startsWith("ERREUR") ? "text-correction" : undefined}>
                  {ligne}
                  {"\n"}
                </span>
              ))}
            </pre>
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

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
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

/** Journal d'audit : chronologie des actions admin (login/logout, CRUD,
 *  imports, signalements résolus…). L'id d'épreuve est CLIQUABLE (ouvre
 *  l'épreuve dans la section Épreuves) et chaque entrée porte son détail
 *  lisible (champs modifiés, fichier supprimé, résumé d'épreuve…). */
function JournalPanel({
  token,
  onOuvrirEpreuve,
}: {
  token: string;
  onOuvrirEpreuve: (id: string) => void;
}) {
  const [events, setEvents] = useState<AdminEvent[] | null>(null);

  useEffect(() => {
    api
      .get<AdminEvent[]>("/api/admin/events?limit=100", authHeaders(token))
      .then(setEvents)
      .catch((err) => {
        if (!purgerSessionExpiree(err)) setEvents([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!events) return <p className="text-sm text-slate">Chargement…</p>;
  if (events.length === 0)
    return (
      <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5 text-sm text-slate">
        Aucun évènement enregistré pour l'instant.
      </div>
    );

  return (
    <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
      <div className="mb-3 flex items-center gap-2">
        <ScrollText size={18} strokeWidth={1.75} aria-hidden="true" className="text-highlight" />
        <h2 className="font-serif-brand text-lg">Journal d'audit</h2>
      </div>
      <ul className="divide-y divide-ink-soft/10 text-sm">
        {events.map((e) => {
          const details = detailsLisibles(e);
          return (
            <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2">
              <span className="font-mono-tag text-[10px] text-highlight">{libelleAction(e.action)}</span>
              <span className="min-w-0 flex-1 truncate">
                {e.email || "système"}
                {e.epreuve_id && (
                  <>
                    {" — "}
                    <button
                      type="button"
                      onClick={() => onOuvrirEpreuve(e.epreuve_id!)}
                      title={e.epreuve_resume || `Ouvrir l'épreuve ${e.epreuve_id} dans la section Épreuves`}
                      className="font-mono-tag text-[11px] text-ink underline decoration-dotted underline-offset-2 hover:text-highlight"
                    >
                      épreuve {e.epreuve_id}
                    </button>
                    {e.epreuve_resume ? <span className="text-xs text-ink-soft"> ({e.epreuve_resume})</span> : null}
                  </>
                )}
                {details ? <span className="text-xs text-slate"> — {details}</span> : null}
              </span>
              <span className="font-mono-tag text-[10px] text-slate" title={new Date(e.created_at).toLocaleString("fr-FR")}>
                {formatRelativeTime(e.created_at)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Détails d'un évènement d'audit traduits en phrase lisible (au lieu du
 * JSON brut) selon le type d'action : champs modifiés, fichier supprimé,
 * motif de bannissement, etc. */
function detailsLisibles(e: AdminEvent): string {
  const d = e.details ?? {};
  const parts: string[] = [];
  if (Array.isArray(d.champs) && d.champs.length > 0) {
    parts.push(`champs : ${(d.champs as string[]).join(", ")}`);
  }
  if (typeof d.filename === "string" && d.filename) parts.push(`fichier « ${d.filename} »`);
  if (typeof d.matiere === "string" && d.matiere) parts.push(`${d.matiere}${d.classe ? ` — ${d.classe}` : ""}${d.annee ? ` (${d.annee})` : ""}`);
  if (typeof d.motif === "string" && d.motif) parts.push(`motif : ${d.motif}`);
  if (typeof d.email_cible === "string" && d.email_cible) parts.push(d.email_cible);
  if (typeof d.statut === "string" && d.statut) parts.push(`→ ${d.statut}`);
  return parts.join(" · ");
}

function libelleAction(action: string): string {
  const noms: Record<string, string> = {
    admin_login: "CONNEXION ADMIN",
    admin_logout: "DÉCONNEXION ADMIN",
    created: "CRÉATION",
    updated: "MODIFICATION",
    published: "PUBLICATION",
    unpublished: "DÉPUBLICATION",
    deleted: "SUPPRESSION",
    signalement_resolu: "SIGNALEMENT RÉSOLU",
    utilisateur_banni: "UTILISATEUR BANNI",
    utilisateur_debanni: "UTILISATEUR DÉBANNI",
    utilisateur_supprime: "UTILISATEUR SUPPRIMÉ",
  };
  if (noms[action]) return noms[action];
  if (action.startsWith("image_uploaded")) return `IMAGE AJOUTÉE (${action.split("_").pop()})`;
  if (action.startsWith("document_uploaded")) return `DOCUMENT REMPLACÉ (${action.split("_").pop()})`;
  if (action.startsWith("file_deleted")) return "FICHIER SUPPRIMÉ";
  if (action.startsWith("import")) return "IMPORT";
  return action.toUpperCase();
}

/** Signalements d'épreuves : liste avec auteur, motif, message, et action
 *  « marquer résolu ». */
function SignalementsPanel({ token }: { token: string }) {
  const { showToast } = useToast();
  const [signalements, setSignalements] = useState<Signalement[] | null>(null);

  function load() {
    api
      .get<Signalement[]>("/api/admin/signalements", authHeaders(token))
      .then(setSignalements)
      .catch((err) => {
        if (!purgerSessionExpiree(err)) setSignalements([]);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function resoudre(id: string) {
    try {
      await api.post(`/api/admin/signalements/${id}/resoudre`, undefined, authHeaders(token));
      showToast("Signalement marqué résolu.", "success");
      load();
    } catch {
      showToast("Échec de la mise à jour du signalement.", "error");
    }
  }

  if (!signalements) return <p className="text-sm text-slate">Chargement…</p>;
  if (signalements.length === 0)
    return (
      <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5 text-sm text-slate">
        Aucun signalement — rien à traiter pour l'instant.
      </div>
    );

  return (
    <div className="space-y-3">
      {signalements.map((s) => (
        <div
          key={s.id}
          className={`rounded-lg border bg-paper-raised p-4 ${
            s.statut === "ouvert" ? "border-correction/30" : "border-ink-soft/15 opacity-70"
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Flag size={15} strokeWidth={1.75} aria-hidden="true" className={s.statut === "ouvert" ? "text-correction" : "text-slate"} />
            <p className="font-medium">
              {MOTIF_LABELS[s.motif] ?? s.motif} — {s.matiere} {s.annee} ({classeLabel(s.classe)})
            </p>
            <span
              className={`ml-auto rounded-full px-2.5 py-0.5 font-mono-tag text-[10px] ${
                s.statut === "ouvert" ? "bg-correction-soft text-correction" : "bg-valide-soft text-valide"
              }`}
            >
              {s.statut === "ouvert" ? "Ouvert" : "Résolu"}
            </span>
          </div>
          {s.message && <p className="mt-2 text-sm text-ink-soft">« {s.message} »</p>}
          <p className="mt-2 font-mono-tag text-[10px] text-slate">
            {s.auteur_email} · {formatRelativeTime(s.created_at)} ·{" "}
            <Link to={`/epreuve/${s.epreuve_id}`} className="underline hover:text-highlight">
              ouvrir l'épreuve
            </Link>
          </p>
          {s.statut === "ouvert" && (
            <button
              type="button"
              onClick={() => resoudre(s.id)}
              className="mt-3 min-h-[36px] rounded-full border border-valide/40 px-4 text-xs font-medium text-valide hover:bg-valide-soft/40"
            >
              Marquer résolu
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Table « Utilisateurs » : une ligne par élève (hors comptes admin),
 * identité déclarée + consentements + compteurs d'usage, et les actions de
 * modération (bannir/débannir/supprimer). Volontairement SANS donnée
 * sensible : rien de secret n'est stocké dans le produit (connexion
 * Google/mock, paiement par référence d'agrégateur), et la table ne
 * présente que ce que l'utilisateur a accepté de partager. */
function UtilisateursPanel({ token }: { token: string }) {
  const { showToast } = useToast();
  const [rows, setRows] = useState<AdminUtilisateur[] | null>(null);

  function load() {
    api
      .get<AdminUtilisateur[]>("/api/admin/utilisateurs", authHeaders(token))
      .then(setRows)
      .catch((err) => {
        if (!purgerSessionExpiree(err)) setRows([]);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

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
    if (
      !window.confirm(
        `Supprimer définitivement ${u.email} et TOUTES ses données (notes, discussions, abonnements, paiements) ? Action irréversible.`
      )
    )
      return;
    try {
      await api.del(`/api/admin/utilisateurs/${u.id}`, authHeaders(token));
      showToast(`${u.email} et ses données ont été supprimés.`, "info");
      load();
    } catch (err) {
      if (!purgerSessionExpiree(err)) showToast("La suppression a échoué — réessaie.", "error");
    }
  }

  if (!rows) return <p className="text-sm text-slate">Chargement…</p>;
  if (rows.length === 0)
    return (
      <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5 text-sm text-slate">
        Aucun utilisateur inscrit pour l'instant (les comptes de la liste blanche admin sont exclus).
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
                    {u.banni ? (
                      <button
                        type="button"
                        onClick={() => debannir(u)}
                        className="flex min-h-[32px] items-center gap-1 rounded-full border border-valide/40 px-3 text-xs font-medium text-valide hover:bg-valide-soft/40"
                      >
                        <ShieldCheck size={12} strokeWidth={2} aria-hidden="true" />
                        Débannir
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => bannir(u)}
                        className="flex min-h-[32px] items-center gap-1 rounded-full border border-ink-soft/25 px-3 text-xs font-medium text-ink-soft hover:border-correction/50 hover:text-correction"
                      >
                        <Ban size={12} strokeWidth={2} aria-hidden="true" />
                        Bannir
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => supprimer(u)}
                      className="min-h-[32px] rounded-full border border-correction/40 px-3 text-xs font-medium text-correction hover:bg-correction-soft/40"
                    >
                      Supprimer
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  documents,
  onDeleteImage,
  onInsertImage,
  onDeleteDocument,
}: {
  title: string;
  required: boolean;
  markdown: string;
  preview: boolean;
  onTogglePreview: () => void;
  onChange: (v: string) => void;
  onUpload: (file: File) => void;
  assets: Asset[];
  documents: DocumentFile[];
  onDeleteImage: (asset: Asset) => void;
  onInsertImage: (asset: Asset) => void;
  onDeleteDocument: (doc: DocumentFile) => void;
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
        {/* Documents Markdown de cette cible : liste TEXTE (distincte de la
            galerie d'images) — corrige l'affichage « sujet.md » comme si
            c'était une image rattachée au sujet. */}
        {documents.length > 0 && (
          <ul className="mb-2 space-y-1">
            {documents.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-2 rounded border border-ink-soft/15 bg-paper px-2 py-1.5 text-xs"
              >
                <FileText size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-soft" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-mono-tag text-[10px]">{d.filename}</span>
                  {d.size_bytes ? ` · ${formatBytes(d.size_bytes)}` : ""}
                  {d.uploaded_at ? ` · ${formatRelativeTime(d.uploaded_at)}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => onDeleteDocument(d)}
                  title="Supprimer ce document"
                  aria-label={`Supprimer le document ${d.filename}`}
                  className="p-1 text-ink-soft hover:text-correction"
                >
                  <X size={13} strokeWidth={2} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
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
                title={`${a.filename}${a.width && a.height ? ` — ${a.width}×${a.height}` : ""}${
                  a.size_bytes ? ` — ${formatBytes(a.size_bytes)}` : ""
                }`}
              >
                <img
                  src={resolveMediaUrl(a.url)}
                  alt={a.filename}
                  className="h-full w-full object-contain"
                  loading="lazy"
                />
                <button
                  type="button"
                  onClick={() => onDeleteImage(a)}
                  title="Retirer cette image (supprime le fichier)"
                  aria-label="Retirer cette image"
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-correction text-paper shadow"
                >
                  <X size={12} strokeWidth={2.5} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => onInsertImage(a)}
                  title="Insérer la balise Markdown de cette image dans le texte"
                  aria-label="Insérer cette image dans le texte"
                  className="absolute bottom-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-valide text-paper shadow"
                >
                  <Plus size={12} strokeWidth={2.5} aria-hidden="true" />
                </button>
              </div>
            ))}
            {/* Métadonnées des fichiers : dimensions et poids, visibles en
                clair sous la rangée de vignettes (aussi en info-bulle). */}
            <div className="w-full space-y-0.5 text-xs text-slate">
              {assets.map((a) => (
                <p key={`meta-${a.id}`} className="truncate">
                  <span className="font-mono-tag text-[10px]">{a.filename}</span>
                  {a.width && a.height ? ` · ${a.width}×${a.height} px` : ""}
                  {a.size_bytes ? ` · ${formatBytes(a.size_bytes)}` : ""}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
