import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { AdminStats } from "../api/types";
import { useToast } from "../components/Toast";
import { EpreuvesPanel } from "./admin/EpreuvesPanel";
import { ImportPanel } from "./admin/ImportPanel";
import { JournalPanel } from "./admin/JournalPanel";
import { SignalementsPanel } from "./admin/SignalementsPanel";
import { StatsPanel } from "./admin/StatsPanel";
import { UtilisateursPanel } from "./admin/UtilisateursPanel";
import { authHeaders } from "./admin/shared";

type Onglet = "epreuves" | "import" | "utilisateurs" | "journal" | "signalements";

/** Coquille du back-office : connexion admin, onglets, statistiques et
 * battement de cœur du verrou. Chaque onglet vit dans son propre panneau
 * (pages/admin/*) — ce fichier ne fait que le routage interne. */
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
  const [tab, setTab] = useState<Onglet>(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return (["epreuves", "import", "utilisateurs", "journal", "signalements"] as const).includes(t as never)
      ? (t as Onglet)
      : "epreuves";
  });

  const [stats, setStats] = useState<AdminStats | null>(null);
  // Épreuve demandée depuis le journal d'audit (lien cliquable) : le shell
  // bascule sur l'onglet Épreuves et EpreuvesPanel précharge son détail.
  const [detailAOpenir, setDetailAOpenir] = useState<string | null>(null);

  // Navigation clavier des onglets (pattern WAI-ARIA) : flèches droite/
  // gauche, Origine (Home) et Fin circulent dans l'ordre visuel affiché.
  function onTabsKeyDown(e: React.KeyboardEvent, current: Onglet) {
    const order: Onglet[] = ["epreuves", "import", "utilisateurs", "signalements", "journal"];
    const idx = order.indexOf(current);
    let next: Onglet | null = null;
    if (e.key === "ArrowRight") next = order[(idx + 1) % order.length];
    else if (e.key === "ArrowLeft") next = order[(idx - 1 + order.length) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (!next) return;
    e.preventDefault();
    setTab(next);
    (e.currentTarget as HTMLElement)
      .closest('[role="tablist"]')
      ?.querySelector<HTMLElement>(`#admin-tab-${next}`)
      ?.focus();
  }

  /** Session admin expirée côté serveur (401) : purge le jeton local pour
   * repasser par le formulaire de connexion. Retourne vrai si c'était un
   * 401 — les autres erreurs restent à la charge de l'appelant. */
  function handle401(err: unknown): boolean {
    if (!(err instanceof ApiError && err.status === 401)) return false;
    setToken(null);
    sessionStorage.removeItem("admin_session");
    return true;
  }

  // Même purge, sans valeur de retour — à passer aux panneaux qui n'ont pas
  // accès à setToken (EpreuvesPanel gère ses 401 localement).
  function onSessionExpiree() {
    setToken(null);
    sessionStorage.removeItem("admin_session");
  }

  async function loadStats(t: string) {
    try {
      const s = await api.get<AdminStats>("/api/admin/stats", authHeaders(t));
      setStats(s);
    } catch (err) {
      handle401(err);
    }
  }

  // Charge les statistiques à la connexion ET après chaque changement
  // d'épreuves (publication/suppression) signalé par le panneau.
  useEffect(() => {
    if (token) loadStats(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

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
    try {
      if (token) await api.post("/api/admin/logout", undefined, authHeaders(token));
    } finally {
      // Reset complet du formulaire : sans lui, les identifiants de la
      // session précédente restaient affichés au retour à l'écran de
      // connexion (risque sur poste partagé).
      sessionStorage.removeItem("admin_session");
      setToken(null);
      setEmail("");
      setLoginToken("");
      setError(null);
      setBlocker(null);
      showToast("Déconnexion admin réussie.", "info");
    }
  }

  if (!token) {
    return (
      <form
        onSubmit={onLoginSubmit}
        className="mx-auto max-w-sm space-y-4 rounded-lg border border-ink-soft/15 bg-paper-raised p-6"
      >
        <h1 className="font-serif-brand text-xl">Connexion administrateur</h1>
        <div>
          <label htmlFor="admin-login-email" className="mb-1 block font-mono-tag text-[10px] text-ink-soft">
            E-mail admin
          </label>
          <input
            id="admin-login-email"
            type="email"
            placeholder="admin@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "admin-login-error" : undefined}
            className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
          />
        </div>
        <div>
          <label htmlFor="admin-login-token" className="mb-1 block font-mono-tag text-[10px] text-ink-soft">
            Jeton d'accès
          </label>
          <input
            id="admin-login-token"
            type="password"
            placeholder="Jeton d'accès (voir ADMIN_TOKEN)"
            value={loginToken}
            onChange={(e) => setLoginToken(e.target.value)}
            autoComplete="current-password"
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "admin-login-error" : undefined}
            className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
          />
        </div>
        {error && (
          <p id="admin-login-error" role="alert" className="text-sm text-correction">
            {error}
          </p>
        )}
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

      {stats && <StatsPanel stats={stats} />}

      <div
        role="tablist"
        aria-label="Sections du back-office"
        className="flex flex-wrap gap-1 rounded-full border border-ink-soft/20 p-1 font-mono-tag text-[10px] w-fit"
      >
        {(
          [
            ["epreuves", "Épreuves"],
            ["import", "Import massif"],
            ["utilisateurs", `Utilisateurs${stats?.utilisateurs ? ` (${stats.utilisateurs})` : ""}`],
            ["signalements", `Signalements${stats?.signalements_ouverts ? ` (${stats.signalements_ouverts})` : ""}`],
            ["journal", "Journal"],
          ] as [Onglet, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            role="tab"
            id={`admin-tab-${v}`}
            aria-selected={tab === v}
            aria-controls="admin-panel"
            tabIndex={tab === v ? 0 : -1}
            onClick={() => setTab(v)}
            onKeyDown={(e) => onTabsKeyDown(e, v)}
            className={`rounded-full px-4 py-1.5 ${tab === v ? "bg-ink text-paper" : "text-ink-soft"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="admin-panel" aria-labelledby={`admin-tab-${tab}`}>
        {tab === "epreuves" ? (
          <EpreuvesPanel
            token={token}
            onSessionExpiree={onSessionExpiree}
            detailAOpenir={detailAOpenir}
            onDetailOuvert={() => setDetailAOpenir(null)}
            onEpreuvesChange={() => loadStats(token)}
          />
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
              setDetailAOpenir(id);
              setTab("epreuves");
            }}
          />
        )}
      </div>
    </div>
  );
}