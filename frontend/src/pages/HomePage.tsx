import { BookOpen, GraduationCap, Lock, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { NavigationOut } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Logo } from "../components/Logo";

/**
 * Accueil public : sélection du niveau (seul Secondaire est actif pour
 * l'instant, Primaire est réservé), puis sélection de la classe — une
 * carte de classe sans épreuve est désactivée. Une barre de recherche
 * globale permet de chercher dans TOUT le catalogue, indépendamment de la
 * classe (prompt d'amélioration §3).
 */
export function HomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [nav, setNav] = useState<NavigationOut | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api.get<NavigationOut>("/api/epreuves/navigation").then(setNav).catch(() => {});
  }, []);

  const secondaire = nav?.niveaux.find((n) => n.code === "SECONDAIRE");
  const primaire = nav?.niveaux.find((n) => n.code === "PRIMAIRE");

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q) navigate(`/catalogue?q=${encodeURIComponent(q)}`);
  }

  return (
    <div className="space-y-10">
      <section className="pt-6 text-center">
        <div className="mb-4 flex justify-center">
          <Logo size={56} />
        </div>
        <h1 className="font-serif-brand text-3xl">Copies &amp; Corrigés</h1>
        <p className="mx-auto mt-2 max-w-xl text-sm text-ink-soft">
          Épreuves et corrigés du secondaire camerounais — de la 6e à la Terminale :
          séquences, compositions, BEPC, Probatoire, BAC et examens blancs.
        </p>

        <form onSubmit={submitSearch} className="mx-auto mt-6 flex max-w-xl gap-2">
          <div className="relative flex-1">
            <Search
              size={18}
              strokeWidth={1.75}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher dans tout le catalogue (matière, série, examen…)"
              aria-label="Recherche globale"
              className="min-h-[44px] w-full rounded-full border border-ink-soft/25 bg-paper-raised pl-10 pr-4 text-sm"
            />
          </div>
          <button
            type="submit"
            className="min-h-[44px] rounded-full bg-ink px-5 text-sm font-medium text-paper"
          >
            Rechercher
          </button>
        </form>

        {!user && (
          <p className="mt-3 text-xs text-slate">
            Consultation libre du catalogue —{" "}
            <Link to="/connexion" className="underline hover:text-highlight">
              se connecter
            </Link>{" "}
            pour ouvrir les épreuves.
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-4 font-mono-tag text-xs text-ink-soft">QUE SOUHAITEZ-VOUS CONSULTER ?</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex min-h-[120px] cursor-not-allowed flex-col justify-between rounded-lg border border-ink-soft/15 bg-paper-raised p-5 opacity-50">
            <div className="flex items-center gap-3">
              <BookOpen size={24} strokeWidth={1.5} aria-hidden="true" className="text-ink-soft" />
              <div>
                <h3 className="font-serif-brand text-lg">Primaire</h3>
                <p className="text-xs text-slate">Bientôt disponible</p>
              </div>
            </div>
            <span className="flex items-center gap-1.5 font-mono-tag text-[10px] text-slate">
              <Lock size={12} strokeWidth={2} aria-hidden="true" />
              {primaire ? `${primaire.classes.reduce((n, c) => n + c.epreuves, 0)} épreuve(s)` : "—"}
            </span>
          </div>

          <div className="flex min-h-[120px] flex-col justify-between rounded-lg border-2 border-highlight/40 bg-paper-raised p-5">
            <div className="flex items-center gap-3">
              <GraduationCap size={24} strokeWidth={1.5} aria-hidden="true" className="text-highlight" />
              <div>
                <h3 className="font-serif-brand text-lg">Secondaire</h3>
                <p className="text-xs text-slate">6e → Terminale</p>
              </div>
            </div>
            <span className="font-mono-tag text-[10px] text-slate">
              {secondaire ? `${secondaire.classes.reduce((n, c) => n + c.epreuves, 0)} épreuve(s) publiée(s)` : "—"}
            </span>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-4 font-mono-tag text-xs text-ink-soft">SECONDAIRE — CHOISIS TA CLASSE</h2>
        {!nav && <p className="text-sm text-slate">Chargement…</p>}
        {nav && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {(secondaire?.classes ?? []).map((c) => {
              const total = c.epreuves;
              return c.actif ? (
                <Link
                  key={c.code}
                  to={`/secondaire/${c.code}`}
                  className="flex min-h-[104px] flex-col justify-between rounded-lg border border-ink-soft/15 bg-paper-raised p-4 text-left transition-colors hover:border-highlight/50 hover:bg-highlight-soft/40 focus-visible:border-highlight/50"
                >
                  <span className="font-serif-brand text-xl">{c.label}</span>
                  <span className="font-mono-tag text-[10px] text-slate">
                    {total} épreuve{total > 1 ? "s" : ""}
                  </span>
                </Link>
              ) : (
                <div
                  key={c.code}
                  title="Aucune épreuve publiée pour cette classe pour l'instant"
                  className="flex min-h-[104px] cursor-not-allowed flex-col justify-between rounded-lg border border-ink-soft/10 bg-paper-raised/50 p-4 opacity-45"
                >
                  <span className="font-serif-brand text-xl">{c.label}</span>
                  <span className="flex items-center gap-1 font-mono-tag text-[10px] text-slate">
                    <Lock size={11} strokeWidth={2} aria-hidden="true" />
                    Bientôt
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
