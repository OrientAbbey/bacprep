import { LangSwitch } from "../i18nProvider";
import { BottomNav } from "./BottomNav";
import { IndicateurConnexion } from "./IndicateurConnexion";
import { ServeurLent } from "./ServeurLent";
import { BandeauAlarme } from "./BandeauAlarme";
import { BoutonInviter } from "./Invitation";
import { CircleHelp, Info, Menu, Moon, Search, ShieldCheck, Sun, X } from "lucide-react";
import React, { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useTheme } from "../theme/ThemeProvider";
import { PhotoProfil } from "./PhotoProfil";
import { Logo } from "./Logo";
import { NotificationsBell } from "./NotificationsBell";
import { NAV_ITEMS } from "./navItems";
import { t } from "../i18n";

export function Layout({ children }: { children?: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);


  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q) {
      // Le nonce force le catalogue à repartir de zéro même si la requête est
      // identique à la précédente (filtres déjà posés).
      navigate(`/catalogue?q=${encodeURIComponent(q)}`, { state: { recherche: Date.now() } });
      setQuery("");
    }
  }

  // Navigation ou Échap → le menu mobile se referme toujours.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <ServeurLent />
      <BandeauAlarme />
      <header data-chrome className="sticky top-0 z-30 border-b border-ink-soft/15 bg-paper-raised">
        {/* Motif signature n°1 : bandeau tricolore, uniquement ici (AppBar) */}
        <div className="flex h-[3px] w-full" aria-hidden="true">
          <div className="flex-1 bg-valide" />
          <div className="flex-1 bg-highlight" />
          <div className="flex-1 bg-correction" />
        </div>

        {/* Conteneur PLEINE LARGEUR (plus de max-w-6xl) : le site profite de
            tout l'écran, le contenu n'est limé au centre que par la grille de
            sa propre page. */}
        <div className="flex w-full items-center gap-3 px-4 py-3 md:px-6 lg:px-8">
          <Link to="/" aria-label={t("Accueil")} className="flex items-center gap-2">
            <Logo size={32} />
            <span className="hidden font-serif-brand text-lg sm:inline">{t("Copies & Corrigés")}</span>
          </Link>

          {/* Recherche d'en-tête : masquée sous xl pour laisser la place aux
              six entrées de navigation (elle reste accessible depuis
              l'accueil, le catalogue et le tiroir). */}
          <form onSubmit={submitSearch} className="mx-auto hidden max-w-xs flex-1 xl:block">
            <div className="relative">
              <Search
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("Rechercher…")}
                aria-label={t("Recherche globale")}
                className="min-h-[44px] w-full rounded-full border border-ink-soft/25 bg-paper px-3 pl-9 text-xs"
              />
            </div>
          </form>

          <nav className="ml-auto flex items-center gap-2 text-sm sm:gap-4">
            {/* Burger MOBILE : regroupe la navigation + compte dans un tiroir */}
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label={t("Ouvrir le menu")}
              aria-expanded={menuOpen}
              className="relative flex h-9 w-9 items-center justify-center rounded-full hover:bg-highlight-soft lg:hidden after:absolute after:-inset-1 after:rounded-full after:content-['']"
            >
              <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>

            {/* Navigation BUREAU (visible dès lg) : mêmes entrées que le
                tiroir mobile et la barre d'onglets, via `navItems.ts`.
                La page ouverte est colorée comme dans la barre d'onglets. */}
            <div className="hidden items-center gap-4 lg:flex">
              {NAV_ITEMS.map(({ to, label, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    `rounded-full px-3 py-2 transition-colors ${
                      isActive
                        ? "bg-highlight-soft font-medium text-highlight-text"
                        : "text-ink-soft hover:bg-paper hover:text-ink"
                    }`
                  }
                >
                  {t(label)}
                </NavLink>
              ))}
              <NavLink
                to="/aide"
                className={({ isActive }) =>
                  `rounded-full px-3 py-2 transition-colors ${
                    isActive
                      ? "bg-highlight-soft font-medium text-highlight-text"
                      : "text-ink-soft hover:bg-paper hover:text-ink"
                  }`
                }
              >
                {t("Aide")}
              </NavLink>
              {/* Console admin : réservée aux comptes de la liste blanche
                  (is_admin calculé serveur) — le lien ne s'affiche même pas
                  pour les autres ; la route reste de toute façon protégée par
                  le jeton admin vérifié à chaque appel API. */}
              {user?.is_admin && (
                <NavLink
                  to="/admin"
                  className={({ isActive }) =>
                    `rounded-full border px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                      isActive
                        ? "border-highlight bg-highlight text-highlight-ink"
                        : "border-highlight/50 text-highlight-text hover:bg-highlight-soft"
                    }`
                  }
                >
                  {t("Admin")}
                </NavLink>
              )}

              {user ? (
                <>
                  <NotificationsBell />
                  <Link
                    to="/profil"
                    aria-label={t("Profil de {nom}", { nom: user.nom })}
                    title={user.nom}
                    className="relative flex h-9 w-9 items-center justify-center rounded-full bg-ink font-mono-tag text-[11px] font-semibold text-paper after:absolute after:-inset-1 after:rounded-full after:content-['']"
                  >
                    <PhotoProfil nom={user.nom} version={user.avatar_version} />
                  </Link>
                </>
              ) : (
                <Link
                  to="/connexion"
                  state={{ from: location }}
                  className="min-h-[44px] rounded-full bg-ink px-4 text-sm font-medium leading-[44px] text-paper hover:opacity-90"
                >
                  {t("Connexion")}
                </Link>
              )}
            </div>

            <IndicateurConnexion />
            <LangSwitch />
            <BoutonInviter
              variante="icone"
              className="relative hidden h-9 w-9 items-center justify-center rounded-full hover:bg-highlight-soft after:absolute after:-inset-1 after:rounded-full after:content-[''] sm:flex"
            />
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={t("Changer de thème")}
              className="relative flex h-9 w-9 items-center justify-center rounded-full hover:bg-highlight-soft after:absolute after:-inset-1 after:rounded-full after:content-['']"
            >
              {theme === "dark" ? (
                <Sun size={20} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Moon size={20} strokeWidth={1.75} aria-hidden="true" />
              )}
            </button>
          </nav>
        </div>
      </header>

      {/* Tiroir de navigation MOBILE : Accueil, Abonnement, Admin (si admin),
          recherche et compte — masqué à partir de sm (papillon bureau). */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={t("Menu")}>
          <div className="absolute inset-0 bg-ink/40" onClick={() => setMenuOpen(false)} aria-hidden="true" />
          <div className="absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-l border-ink-soft/15 bg-paper p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <p className="font-serif-brand text-sm">{t("Navigation")}</p>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label={t("Fermer le menu")}
                className="relative flex h-9 w-9 items-center justify-center rounded-full hover:bg-highlight-soft after:absolute after:-inset-1 after:rounded-full after:content-['']"
              >
                <X size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={submitSearch} className="relative mb-4">
              <Search
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("Rechercher une épreuve…")}
                aria-label={t("Recherche globale")}
                autoFocus
                className="min-h-[44px] w-full rounded-full border border-ink-soft/25 bg-paper-raised px-3 pl-9 text-sm"
              />
            </form>

            <nav className="flex flex-col gap-1">
              {NAV_ITEMS.map(({ to, label, Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-lg px-3 py-2.5 ${
                      isActive
                        ? "bg-highlight-soft font-medium text-highlight-text"
                        : "hover:bg-highlight-soft"
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon
                        size={18}
                        strokeWidth={1.75}
                        aria-hidden="true"
                        className={`shrink-0 ${isActive ? "" : "text-ink-soft"}`}
                      />
                      {t(label)}
                    </>
                  )}
                </NavLink>
              ))}
              <NavLink
                to="/aide"
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg px-3 py-2.5 ${
                    isActive
                      ? "bg-highlight-soft font-medium text-highlight-text"
                      : "hover:bg-highlight-soft"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <CircleHelp size={18} strokeWidth={1.75} aria-hidden="true" className={`shrink-0 ${isActive ? "" : "text-ink-soft"}`} />
                    {t("Aide")}
                  </>
                )}
              </NavLink>
              <NavLink
                to="/a-propos"
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg px-3 py-2.5 ${
                    isActive
                      ? "bg-highlight-soft font-medium text-highlight-text"
                      : "hover:bg-highlight-soft"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Info size={18} strokeWidth={1.75} aria-hidden="true" className={`shrink-0 ${isActive ? "" : "text-ink-soft"}`} />
                    {t("À propos")}
                  </>
                )}
              </NavLink>
              <BoutonInviter variante="lien" className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-highlight-soft" />
              {user?.is_admin && (
                <NavLink
                  to="/admin"
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-lg px-3 py-2.5 font-medium ${
                      isActive
                        ? "bg-highlight-soft text-highlight-text"
                        : "text-highlight-text hover:bg-highlight-soft"
                    }`
                  }
                >
                  <ShieldCheck size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
                  {t("Admin")}
                </NavLink>
              )}
            </nav>

            <div className="mt-4 border-t border-ink-soft/15 pt-4">
              {user ? (
                <>
                  <div className="mb-3 flex items-center gap-2.5 px-3">
                    <NotificationsBell />
                    <span className="font-mono-tag text-[10px] text-slate">{t("Notifications")}</span>
                  </div>
                  <Link to="/profil" className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-highlight-soft">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink font-mono-tag text-[11px] font-semibold text-paper">
                      <PhotoProfil nom={user.nom} version={user.avatar_version} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{user.nom || user.email}</span>
                      <span className="block font-mono-tag text-[10px] text-slate">{t("Mon profil")}</span>
                    </span>
                  </Link>
                </>
              ) : (
                <Link
                  to="/connexion"
                  state={{ from: location }}
                  className="flex min-h-[44px] items-center justify-center rounded-full bg-ink text-sm font-medium text-paper hover:opacity-90"
                >
                  {t("Connexion")}
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      <main className="w-full flex-1 px-4 py-6 pb-24 sm:pb-6 md:px-6 lg:px-8">{children ?? <Outlet />}</main>

      <BottomNav />
      <footer data-chrome className="border-t border-ink-soft/15 px-4 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-4 text-center text-xs text-slate sm:pb-6">
        <nav aria-label={t("Informations")} className="mb-0 flex flex-wrap items-center justify-center gap-x-4 gap-y-0.5">
          <Link to="/confidentialite" className="inline-flex min-h-[32px] items-center underline underline-offset-2 hover:text-ink">
            {t("Confidentialité")}
          </Link>
          <Link to="/conditions" className="inline-flex min-h-[32px] items-center underline underline-offset-2 hover:text-ink">
            {t("Conditions")}
          </Link>
          <Link to="/a-propos" className="inline-flex min-h-[32px] items-center underline underline-offset-2 hover:text-ink">
            {t("À propos")}
          </Link>
          <Link to="/aide" className="inline-flex min-h-[32px] items-center underline underline-offset-2 hover:text-ink">
            {t("Aide")}
          </Link>
          <BoutonInviter variante="lien" className="inline-flex min-h-[32px] items-center underline underline-offset-2 hover:text-ink" />
        </nav>
        <p className="mt-0.5">{t("Copies & Corrigés — Épreuves et corrigés du secondaire camerounais (6e → Terminale)")}</p>
      </footer>
    </div>
  );
}
