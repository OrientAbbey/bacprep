import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { api, ApiError } from "../api/client";
import { AdminStats } from "../api/types";
import { useToast } from "../components/Toast";
import { CalendrierPanel } from "./admin/CalendrierPanel";
import { EpreuvesPanel } from "./admin/EpreuvesPanel";
import { ImportPanel } from "./admin/ImportPanel";
import { JournalPanel } from "./admin/JournalPanel";
import { NotificationsPanel } from "./admin/NotificationsPanel";
import { ParametresPanel } from "./admin/ParametresPanel";
import { PlansPanel } from "./admin/PlansPanel";
import { SauvegardesPanel } from "./admin/SauvegardesPanel";
import { SignalementsPanel } from "./admin/SignalementsPanel";
import { StatsPanel } from "./admin/StatsPanel";
import { UtilisateursPanel } from "./admin/UtilisateursPanel";
import { authHeaders } from "./admin/shared";

type Onglet =
  | "epreuves"
  | "import"
  | "sauvegardes"
  | "utilisateurs"
  | "parametres"
  | "formules"
  | "calendrier"
  | "journal"
  | "signalements"
  | "notifications";

/** Coquille du back-office : connexion admin, onglets, statistiques et
 * battement de cœur du verrou. Chaque onglet vit dans son propre panneau
 * (pages/admin/*) — ce fichier ne fait que le routage interne. */
export function AdminPage() {
  const { showToast } = useToast();
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [loginToken, setLoginToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocker, setBlocker] = useState<{ message: string; active_email: string } | null>(null);

  // Onglet initial lisible depuis l'URL (/admin?tab=utilisateurs) : lien
  // profond depuis le journal d'audit ou un signet — les onglets restent
  // ensuite pilotés par les boutons (pas de synchronisation bidirectionnelle
  // volontaire pour garder l'URL stable).
  const [tab, setTab] = useState<Onglet>(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return (["epreuves", "import", "sauvegardes", "utilisateurs", "parametres", "formules", "calendrier", "journal", "signalements", "notifications"] as const).includes(t as never)
      ? (t as Onglet)
      : "epreuves";
  });

  const [stats, setStats] = useState<AdminStats | null>(null);
  // Vérification de la session en cours de sondage à l'ouverture : évite le
  // FLASH du formulaire de connexion pendant que /stats répond (la session
  // vit dans un cookie httpOnly illisible par le JS — voir commentaire du
  // sondage ci-dessous). Un écran de vérification (spinner) tient lieu de
  // formulaire jusqu'à la réponse.
  const [verification, setVerification] = useState(true);
  // Épreuve demandée depuis le journal d'audit (lien cliquable) : le shell
  // bascule sur l'onglet Épreuves et EpreuvesPanel précharge son détail.
  const [detailAOpenir, setDetailAOpenir] = useState<string | null>(null);

  // Navigation clavier des onglets (pattern WAI-ARIA) : flèches droite/
  // gauche, Origine (Home) et Fin circulent dans l'ordre visuel affiché.
  function onTabsKeyDown(e: React.KeyboardEvent, current: Onglet) {
    const order: Onglet[] = ["epreuves", "import", "sauvegardes", "utilisateurs", "parametres", "formules", "calendrier", "notifications", "signalements", "journal"];
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

  /** Session admin expirée côté serveur (401) : repasse par le formulaire
   * de connexion avec un champ jeton VIDÉ (le jeton de la session précédente
   * ne doit pas rester lisible sur un poste partagé). Retourne vrai si c'était
   * un 401 — les autres erreurs restent à la charge de l'appelant. */
  function handle401(err: unknown): boolean {
    if (!(err instanceof ApiError && err.status === 401)) return false;
    setToken("");
    setLoginToken("");
    setShowToken(false);
    setError(null);
    setBlocker(null);
    return true;
  }

  // Même purge, sans valeur de retour — à passer aux panneaux qui n'ont pas
  // accès à setToken (EpreuvesPanel gère ses 401 localement).
  function onSessionExpiree() {
    handle401(new ApiError(401, "expirée"));
  }

  // 401 signalé par un panneau distant (purgerSessionExpiree) : le shell
  // purge sa session — la page repasse par le formulaire SANS rechargement.
  useEffect(() => {
    const handler = () => handle401(new ApiError(401, "expirée"));
    window.addEventListener("admin:session-expiree", handler);
    return () => window.removeEventListener("admin:session-expiree", handler);
  }, []);

  async function loadStats(t: string): Promise<boolean> {
    try {
      const s = await api.get<AdminStats>("/api/admin/stats", authHeaders(t));
      setStats(s);
      return true;
    } catch (err) {
      handle401(err);
      return false;
    }
  }

  // À l'ouverture de la page, le jeton de session (cookie httpOnly) n'est
  // pas lisible par le JavaScript : on sonde le verrou via /stats —
  // succès = la session a survécu au rechargement, 401 = formulaire de
  // connexion. Chargement des stats initié ici UNIQUEMENT (pas d'effet
  // [token], qui rechargerait deux fois à l'ouverture).
  useEffect(() => {
    let alive = true;
    loadStats("actif").then((ok) => {
      if (!alive) return;
      setVerification(false);
      if (ok) setToken("actif");
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // Garde anti-recouvrement : sans elle, un serveur qui met plus de 30 s à
    // répondre voit les battements s'empiler (plusieurs requêtes ouvertes en
    // parallèle) et, à l'expiration, appeler handle401 autant de fois.
    let enVol = false;
    const battement = setInterval(async () => {
      if (enVol) return;
      enVol = true;
      try {
        await api.post("/api/admin/heartbeat", undefined, authHeaders(token));
      } catch (err) {
        handle401(err);
      } finally {
        enVol = false;
      }
    }, 30_000);
    return () => clearInterval(battement);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function login(force = false) {
    setError(null);
    setBlocker(null);
    try {
      await api.post<{ email: string }>("/api/admin/login", {
        email,
        token: loginToken,
        force,
      });
      // Le serveur a posé le cookie httpOnly : la session est active, mais
      // le jeton reste invisible pour le JS — `token` n'est qu'un drapeau.
      setToken("actif");
      // Le cookie est déjà posé : charge les stats immédiatement au lieu de
      // laisser le tableau de bord sans compteurs jusqu'à un rafraîchissement.
      void loadStats("actif");
      showToast(`Connecté en tant que ${email}.`, "success");
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
      // La session part par le cookie httpOnly ; le serveur l'efface.
      await api.post("/api/admin/logout", undefined, authHeaders(token));
    } catch {
      // ÉCHEC : on ne vide PAS l'état. Le cookie de session reste valide
      // côté serveur, donc afficher l'écran de connexion ferait croire à une
      // déconnexion alors que la session est toujours active — le prochain
      // appel du navigateur repartirait avec le cookie. Prévenir l'admin et
      // le laisser réessayer.
      setError("Déconnexion impossible — la session reste active côté serveur. Réessaie.");
      return;
    }
    // Reset complet du formulaire : sans lui, les identifiants de la
    // session précédente restaient affichés au retour à l'écran de
    // connexion (risque sur poste partagé).
    setToken("");
    setEmail("");
    setLoginToken("");
    setError(null);
    setBlocker(null);
    showToast("Déconnexion admin réussie.", "info");
  }

  if (verification) {
    return (
      <div role="status" aria-live="polite" className="flex items-center gap-3 text-sm text-slate">
        <span
          aria-hidden="true"
          className="h-4 w-4 animate-spin rounded-full border-2 border-ink-soft/25 border-t-ink motion-reduce:animate-none"
        />
        Vérification de la session administrateur…
      </div>
    );
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
          <div className="relative">
            <input
              id="admin-login-token"
              type={showToken ? "text" : "password"}
              placeholder="Jeton d'accès (voir ADMIN_TOKEN)"
              value={loginToken}
              onChange={(e) => setLoginToken(e.target.value)}
              autoComplete="current-password"
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "admin-login-error" : undefined}
              className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 pr-10 text-sm"
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? "Masquer le jeton" : "Afficher le jeton"}
              className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full hover:bg-highlight-soft after:absolute after:-inset-1.5 after:rounded-full after:content-['']"
            >
              {showToken ? (
                <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
              )}
            </button>
          </div>
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
              className="min-h-[44px] rounded-full bg-correction px-4 text-xs font-medium text-paper"
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
            ["sauvegardes", "Sauvegardes"],
            ["utilisateurs", `Utilisateurs${stats?.utilisateurs ? ` (${stats.utilisateurs})` : ""}`],
            ["parametres", "Paramètres"],
            ["formules", "Formules"],
            ["calendrier", "Calendrier"],
            ["notifications", "Notifications"],
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
            className={`min-h-[44px] rounded-full px-4 py-1.5 ${tab === v ? "bg-ink text-paper" : "text-ink-soft"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="admin-panel" aria-labelledby={`admin-tab-${tab}`}>
        {/* EpreuvesPanel reste MONTÉ et simplement masqué quand on quitte
            l'onglet : son état (formulaire en cours, brouillon, assistant
            admin ouvert) survit à la navigation. La version précédente le
            démontait et perdait TOUTE modification non sauvegardée au
            changement d'onglet (revue 2026-09, REVUE_FRONTEND.md F2).
            `display:none` masque aussi le bouton flottant fixe de
            l'assistant, qui n'apparaît que sur l'onglet Épreuves. */}
        <div hidden={tab !== "epreuves"}>
          <EpreuvesPanel
            token={token}
            onSessionExpiree={onSessionExpiree}
            detailAOpenir={detailAOpenir}
            onDetailOuvert={() => setDetailAOpenir(null)}
            onEpreuvesChange={() => loadStats(token)}
          />
        </div>
        {tab === "import" ? (
          <ImportPanel token={token} />
        ) : tab === "sauvegardes" ? (
          <SauvegardesPanel token={token} />
        ) : tab === "utilisateurs" ? (
          <UtilisateursPanel token={token} />
        ) : tab === "parametres" ? (
          <ParametresPanel token={token} />
        ) : tab === "formules" ? (
          <PlansPanel token={token} />
        ) : tab === "calendrier" ? (
          <CalendrierPanel token={token} />
        ) : tab === "notifications" ? (
          <NotificationsPanel token={token} />
        ) : tab === "signalements" ? (
          <SignalementsPanel token={token} />
        ) : tab === "journal" ? (
          <JournalPanel
            token={token}
            onOuvrirEpreuve={(id) => {
              setDetailAOpenir(id);
              setTab("epreuves");
            }}
          />
        ) : (
          // Onglet « épreuves » : contenu déjà rendu (et conservé monté)
          // dans la div masquée ci-dessus — rien d'autre à afficher ici.
          null
        )}
      </div>
    </div>
  );
}