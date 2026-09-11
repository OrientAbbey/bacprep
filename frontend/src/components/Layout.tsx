import { Moon, Search, Sun } from "lucide-react";
import React, { useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useTheme } from "../theme/ThemeProvider";
import { getInitials } from "../lib/initials";
import { Logo } from "./Logo";

export function Layout({ children }: { children?: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [query, setQuery] = useState("");

  const showBack = !["/", "/catalogue"].includes(location.pathname) && !location.pathname.startsWith("/secondaire/");

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q) {
      navigate(`/catalogue?q=${encodeURIComponent(q)}`);
      setQuery("");
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <header className="sticky top-0 z-30 border-b border-ink-soft/15 bg-paper-raised">
        {/* Motif signature n°1 : bandeau tricolore, uniquement ici (AppBar) */}
        <div className="flex h-[3px] w-full" aria-hidden="true">
          <div className="flex-1 bg-valide" />
          <div className="flex-1 bg-highlight" />
          <div className="flex-1 bg-correction" />
        </div>

        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
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
                className="min-h-[36px] w-full rounded-full border border-ink-soft/25 bg-paper px-3 pl-9 text-xs"
              />
            </div>
          </form>

          <nav className="ml-auto flex items-center gap-4 text-sm">
            <Link to="/" className="hover:text-highlight">
              Accueil
            </Link>
            <Link to="/abonnement" className="hidden sm:inline hover:text-highlight">
              Abonnement
            </Link>
            {/* Console admin : réservée aux comptes de la liste blanche
                (is_admin calculé serveur) — le lien ne s'affiche même pas
                pour les autres ; la route reste de toute façon protégée par
                le jeton admin vérifié à chaque appel API. */}
            {user?.is_admin && (
              <Link to="/admin" className="hidden sm:inline hover:text-highlight">
                Admin
              </Link>
            )}

            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Changer de thème"
              className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-highlight-soft"
            >
              {theme === "dark" ? (
                <Sun size={20} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Moon size={20} strokeWidth={1.75} aria-hidden="true" />
              )}
            </button>

            {user ? (
              <Link
                to="/profil"
                aria-label={`Profil de ${user.nom}`}
                title={user.nom}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-ink font-mono-tag text-[11px] font-semibold text-paper"
              >
                {getInitials(user.nom)}
              </Link>
            ) : (
              <Link
                to="/connexion"
                state={{ from: location }}
                className="min-h-[36px] rounded-full bg-ink px-4 text-sm font-medium leading-[36px] text-paper hover:opacity-90"
              >
                Connexion
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children ?? <Outlet />}</main>

      <footer className="border-t border-ink-soft/15 px-4 py-6 text-center text-xs text-slate">
        Copies &amp; Corrigés — Épreuves et corrigés du secondaire camerounais (6e → Terminale)
      </footer>
    </div>
  );
}
