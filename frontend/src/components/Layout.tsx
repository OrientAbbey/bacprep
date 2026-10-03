import { ServeurLent } from "./ServeurLent";
import { Menu, Moon, Search, Sun, X } from "lucide-react";
import React, { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useTheme } from "../theme/ThemeProvider";
import { getInitials } from "../lib/initials";
import { Logo } from "./Logo";
import { NotificationsBell } from "./NotificationsBell";

export function Layout({ children }: { children?: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  const showBack = !["/", "/catalogue"].includes(location.pathname) && !location.pathname.startsWith("/secondaire/");

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q) {
      navigate(`/catalogue?q=${encodeURIComponent(q)}`);
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
      <header className="sticky top-0 z-30 border-b border-ink-soft/15 bg-paper-raised">
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
          <Link to="/" aria-label="Accueil" className="flex items-center gap-2">
            <Logo size={32} />
            <span className="hidden font-serif-brand text-lg sm:inline">Copies &amp; Corrigés</span>
          </Link>

          <form onSubmit={submitSearch} className="mx-auto hidden max-w-xs flex-1 md:block">
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
                placeholder="Rechercher…"
                aria-label="Recherche globale"
                className="min-h-[44px] w-full rounded-full border border-ink-soft/25 bg-paper px-3 pl-9 text-xs"
              />
            </div>
          </form>

          <nav className="ml-auto flex items-center gap-2 text-sm sm:gap-4">
            {/* Burger MOBILE : regroupe la navigation + compte dans un tiroir */}
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Ouvrir le menu"
              aria-expanded={menuOpen}
              className="relative flex h-9 w-9 items-center justify-center rounded-full hover:bg-highlight-soft sm:hidden after:absolute after:-inset-1 after:rounded-full after:content-['']"
            >
              <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>

            {/* Navigation BUREAU (visible dès sm) */}
            <div className="hidden items-center gap-4 sm:flex">
              <Link to="/" className="hover:text-ink">
                Accueil
              </Link>
              <Link to="/abonnement" className="hover:text-ink">
                Abonnement
              </Link>
              {/* Console admin : réservée aux comptes de la liste blanche
                  (is_admin calculé serveur) — le lien ne s'affiche même pas
                  pour les autres ; la route reste de toute façon protégée par
                  le jeton admin vérifié à chaque appel API. */}
              {user?.is_admin && (
                <Link to="/admin" className="hover:text-ink">
                  Admin
                </Link>
              )}

              {user ? (
                <>
                  <NotificationsBell />
                  <Link
                    to="/profil"
                    aria-label={`Profil de ${user.nom}`}
                    title={user.nom}
                    className="relative flex h-9 w-9 items-center justify-center rounded-full bg-ink font-mono-tag text-[11px] font-semibold text-paper after:absolute after:-inset-1 after:rounded-full after:content-['']"
                  >
                    {getInitials(user.nom)}
                  </Link>
                </>
              ) : (
                <Link
                  to="/connexion"
                  state={{ from: location }}
                  className="min-h-[44px] rounded-full bg-ink px-4 text-sm font-medium leading-[44px] text-paper hover:opacity-90"
                >
                  Connexion
                </Link>
              )}
            </div>

            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Changer de thème"
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
        <div className="fixed inset-0 z-50 sm:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setMenuOpen(false)} aria-hidden="true" />
          <div className="absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-l border-ink-soft/15 bg-paper p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <p className="font-serif-brand text-sm">Navigation</p>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="Fermer le menu"
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
                placeholder="Rechercher une épreuve…"
                aria-label="Recherche globale"
                autoFocus
                className="min-h-[44px] w-full rounded-full border border-ink-soft/25 bg-paper-raised px-3 pl-9 text-sm"
              />
            </form>

            <nav className="flex flex-col gap-1">
              <Link to="/" className="rounded-lg px-3 py-2.5 hover:bg-highlight-soft">
                Accueil
              </Link>
              <Link to="/abonnement" className="rounded-lg px-3 py-2.5 hover:bg-highlight-soft">
                Abonnement
              </Link>
              {user?.is_admin && (
                <Link to="/admin" className="rounded-lg px-3 py-2.5 font-medium text-highlight hover:bg-highlight-soft">
                  Admin
                </Link>
              )}
            </nav>

            <div className="mt-4 border-t border-ink-soft/15 pt-4">
              {user ? (
                <>
                  <div className="mb-3 flex items-center gap-2.5 px-3">
                    <NotificationsBell />
                    <span className="font-mono-tag text-[10px] text-slate">Notifications</span>
                  </div>
                  <Link to="/profil" className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-highlight-soft">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink font-mono-tag text-[11px] font-semibold text-paper">
                      {getInitials(user.nom)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{user.nom || user.email}</span>
                      <span className="block font-mono-tag text-[10px] text-slate">Mon profil</span>
                    </span>
                  </Link>
                </>
              ) : (
                <Link
                  to="/connexion"
                  state={{ from: location }}
                  className="flex min-h-[44px] items-center justify-center rounded-full bg-ink text-sm font-medium text-paper hover:opacity-90"
                >
                  Connexion
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      <main className="w-full flex-1 px-4 py-6 md:px-6 lg:px-8">{children ?? <Outlet />}</main>

      <footer className="border-t border-ink-soft/15 px-4 py-6 text-center text-xs text-slate">
        Copies &amp; Corrigés — Épreuves et corrigés du secondaire camerounais (6e → Terminale)
      </footer>
    </div>
  );
}
