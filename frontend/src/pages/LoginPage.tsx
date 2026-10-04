import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { GoogleSignInButton } from "../components/GoogleSignInButton";
import { Logo } from "../components/Logo";
import { useAuth } from "../auth/AuthProvider";
import { t } from "../i18n";

interface AuthConfig {
  mode: "mock" | "google";
  google_client_id: string | null;
}

export function LoginPage() {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const [email, setEmail] = useState("");
  const [nom, setNom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { loginMock, loginGoogle, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Après connexion : retourne à la page d'origine si elle exigeait une
  // authentification (transmise par RequireAuth), accueil sinon.
  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? "/";

  const fetchConfig = useCallback(() => {
    setConfigError(false);
    api.get<AuthConfig>("/api/auth/config")
      .then(setConfig)
      .catch(() => setConfigError(true));
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  useEffect(() => {
    if (user) navigate(from, { replace: true });
  }, [user, navigate, from]);

  async function submitMock(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await loginMock(email, nom);
      navigate(from);
    } catch {
      setError(t("Connexion impossible. Vérifie les champs et réessaie."));
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <div className="flex h-[3px] w-full" aria-hidden="true">
        <div className="flex-1 bg-valide" />
        <div className="flex-1 bg-highlight" />
        <div className="flex-1 bg-correction" />
      </div>

      <div className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-lg border border-ink-soft/15 bg-paper-raised p-8 text-center shadow-sm">
          <div className="mb-4 flex justify-center">
            <Logo size={56} />
          </div>
          <h1 className="font-serif-brand text-2xl">{t("Copies & Corrigés")}</h1>
          <p className="mt-1 mb-6 text-sm text-ink-soft">
            {t("Connecte-toi pour ouvrir les épreuves et tes abonnements.")}
          </p>

          {!config && !configError && (
            <div className="skeleton h-10 w-full rounded-[2px]" role="status" aria-label={t("Chargement de la configuration")} />
          )}

          {configError && (
            <div className="text-center">
              <p role="alert" className="text-sm text-correction">
                {t("Impossible de contacter le serveur. Vérifie ta connexion.")}
              </p>
              <button
                type="button"
                onClick={fetchConfig}
                className="mt-3 min-h-[44px] rounded-full border border-ink-soft/25 bg-paper-raised px-6 text-sm font-medium hover:opacity-80"
              >
                {t("Réessayer")}
              </button>
            </div>
          )}

          {config?.mode === "google" && config.google_client_id && (
            <div className="flex justify-center">
              <GoogleSignInButton
                clientId={config.google_client_id}
                onCredential={(cred) => loginGoogle(cred).then(() => navigate(from))}
              />
            </div>
          )}

          {config?.mode === "mock" && (
            <form onSubmit={submitMock} className="space-y-3 text-left">
              <div>
                <label className="mb-1 block font-mono-tag text-[10px] text-ink-soft">{t("Nom")}</label>
                <input
                  required
                  value={nom}
                  onChange={(e) => setNom(e.target.value)}
                  placeholder={t("ex. Franck Albert")}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "login-error" : undefined}
                  className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block font-mono-tag text-[10px] text-ink-soft">{t("E-mail")}</label>
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t("ex. franck.albert@exemple.com")}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "login-error" : undefined}
                  className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
                />
              </div>
              {error && <p id="login-error" role="alert" className="text-sm text-correction">{error}</p>}
              <button
                type="submit"
                className="min-h-[44px] w-full rounded-full bg-ink text-sm font-medium text-paper"
              >
                {t("Se connecter")}
              </button>
              <p className="text-center text-xs text-slate">
                {t("Mode démonstration — aucun mot de passe requis.")}
              </p>
            </form>
          )}

          <p className="mt-6 text-xs text-slate">
            <Link to="/" className="underline hover:text-ink">
              {t("← Retour à l'accueil")}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
