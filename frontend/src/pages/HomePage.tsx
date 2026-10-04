import { ArrowLeft, BookOpen, ChevronRight, GraduationCap, Lock, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { Consultation, Evenement, NavigationOut, NiveauNav, Revision } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { joursAvant, prochainExamen } from "../lib/calendrier";
import { classeLabel } from "../lib/referentiel";
import { formatRelativeTime } from "../lib/time";
import { Logo } from "../components/Logo";
import { t } from "../i18n";

/**
 * Accueil public, organisé en DECK séquentiel (pas tout en même temps) :
 * l'élève choisit d'abord un NIVEAU parmi des cartes toutes entièrement
 * visibles (le niveau inactif — Primaire — reste visible mais verrouillé),
 * puis la sélection des CLASSES de ce niveau apparaît. Un fil d'Ariane et
 * le bouton retour permettent de remonter à tout moment. La recherche
 * globale reste accessible en permanence (prompt d'amélioration §3).
 */

/** Descriptif affiché sous le libellé de chaque niveau. */
const NIVEAU_DESCRIPTIONS: Record<string, string> = {
  SECONDAIRE: "6e → Terminale",
  PRIMAIRE: "SIL → CM2",
};

export function HomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [nav, setNav] = useState<NavigationOut | null>(null);
  const [navErreur, setNavErreur] = useState(false);
  const [query, setQuery] = useState("");
  const [niveauActif, setNiveauActif] = useState<NiveauNav | null>(null);
  // « Consultées récemment » : réservé aux comptes connectés (l'historique
  // est une fonctionnalité de compte — le visiteur n'en génère pas).
  const [historique, setHistorique] = useState<Consultation[]>([]);

  const chargerNav = useCallback(() => {
    setNavErreur(false);
    api
      .get<NavigationOut>("/api/epreuves/navigation")
      .then(setNav)
      .catch(() => setNavErreur(true));
  }, []);

  useEffect(() => {
    chargerNav();
  }, [chargerNav]);

  // Compte à rebours (prochain examen du calendrier) et révisions dues : discrets,
  // la page reste utilisable s'ils échouent.
  const [examen, setExamen] = useState<Evenement | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  useEffect(() => {
    api.get<Evenement[]>("/api/calendrier").then((l) => setExamen(prochainExamen(l))).catch(() => {});
  }, []);
  useEffect(() => {
    if (!user) return setRevisions([]);
    api.get<Revision[]>("/api/me/revisions").then(setRevisions).catch(() => {});
  }, [user]);

  useEffect(() => {
    if (!user) {
      setHistorique([]);
      return;
    }
    // Silence volontaire : l'historique est secondaire, et les visiteurs
    // non connectés reçoivent un 401 inoffensif (catalogue public).
    api.get<Consultation[]>("/api/me/historique").then(setHistorique).catch(() => {});
  }, [user]);

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
        <h1 className="font-serif-brand text-3xl">{t("Copies & Corrigés")}</h1>
        <p className="mx-auto mt-2 max-w-xl text-sm text-ink-soft">{t("Épreuves et corrigés du secondaire camerounais — de la 6e à la Terminale : séquences, compositions, BEPC, Probatoire, BAC et examens blancs.")}</p>

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
              placeholder={t("Rechercher dans tout le catalogue (matière, série, examen…)")}
              aria-label={t("Recherche globale")}
              className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised pl-10 pr-4 text-sm"
            />
          </div>
          <button
            type="submit"
            className="min-h-[44px] rounded-full bg-ink px-5 text-sm font-medium text-paper"
          >
            {t("Rechercher")}
          </button>
        </form>

        {!user && (
          <p className="mt-3 text-xs text-slate">
            {t("Consultation libre du catalogue —")}{" "}
            <Link to="/connexion" className="underline hover:text-ink">
              {t("se connecter")}
            </Link>{" "}
            {t("pour ouvrir les épreuves.")}
          </p>
        )}
      </section>

      {examen && (
        <Link
          to="/calendrier"
          className="mx-auto flex max-w-xl items-center justify-between gap-3 rounded-lg border border-highlight/40 bg-highlight-soft/50 px-4 py-3 text-sm"
        >
          <span className="min-w-0 truncate">{examen.titre}</span>
          <strong className="font-mono-tag shrink-0 text-highlight-text">
            {joursAvant(examen.date_debut) > 0 ? `J−${joursAvant(examen.date_debut)}` : "En cours"}
          </strong>
        </Link>
      )}

      {user && revisions.length > 0 && (
        <section aria-label={t("À revoir aujourd'hui")}>
          <h2 className="font-mono-tag mb-2 text-xs text-ink-soft">{t("À REVOIR AUJOURD'HUI")}</h2>
          <div className="scrollbar-hide flex gap-3 overflow-x-auto pb-2">
            {revisions.map((r) => (
              <Link
                key={r.epreuve_id}
                to={`/epreuve/${r.epreuve_id}`}
                className="min-w-[180px] shrink-0 rounded-lg border border-highlight/40 bg-paper-raised p-3 text-left transition-colors hover:bg-highlight-soft/40"
              >
                <p className="font-serif-brand text-sm">{r.matiere}</p>
                <p className="font-mono-tag text-[10px] text-slate">
                  {r.evaluation} · {r.annee}
                  {r.derniere_note !== null ? t(" · dernière note {n}/20", { n: r.derniere_note }) : ""}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {user && historique.length > 0 && (
        <section aria-label={t("Consultées récemment")}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-mono-tag text-xs text-ink-soft">{t("CONSULTÉES RÉCEMMENT")}</h2>
            <Link to="/profil" className="text-xs text-ink-soft underline-offset-2 hover:text-ink hover:underline">
              {t("Tout voir dans ton profil")}
            </Link>
          </div>
          <div className="scrollbar-hide flex gap-3 overflow-x-auto pb-2">
            {historique.map((h) => (
              <Link
                key={h.epreuve_id}
                to={`/epreuve/${h.epreuve_id}`}
                className="min-w-[180px] shrink-0 rounded-lg border border-ink-soft/15 bg-paper-raised p-3 text-left transition-colors hover:border-highlight/50 hover:bg-highlight-soft/40 focus-visible:border-highlight/50"
              >
                <p className="font-serif-brand text-sm">{h.matiere}</p>
                <p className="font-mono-tag text-[10px] text-slate">
                  {h.classe ? `${classeLabel(h.classe)} · ` : ""}
                  {h.filieres.join(",")} · {h.annee}
                </p>
                <p className="mt-0.5 text-xs text-slate">{formatRelativeTime(h.consulted_at)}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-4 flex items-center justify-between gap-3">
          {niveauActif ? (
            <nav aria-label={t("Fil d'Ariane")} className="flex min-w-0 items-center gap-1 font-mono-tag text-xs">
              <button
                type="button"
                onClick={() => setNiveauActif(null)}
                className="shrink-0 text-ink-soft underline-offset-2 hover:text-ink hover:underline focus-visible:text-ink"
              >
                {t("Niveaux")}
              </button>
              <ChevronRight size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-slate" />
              <span aria-current="page" className="truncate text-ink-soft">
                NIVEAU {niveauActif.label.toUpperCase()} — CHOISIS TA CLASSE
              </span>
            </nav>
          ) : (
            <h2 className="font-mono-tag text-xs text-ink-soft">{t("QUE SOUHAITEZ-VOUS CONSULTER ?")}</h2>
          )}
          {niveauActif && (
            <button
              type="button"
              onClick={() => setNiveauActif(null)}
              aria-label={t("Revenir à la sélection des niveaux")}
              className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border border-ink-soft/25 px-3 text-xs text-ink-soft hover:border-highlight/50 hover:bg-highlight-soft/40"
            >
              <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
              {t("Niveaux")}
            </button>
          )}
        </div>

        {navErreur && (
          <div role="alert" className="mx-auto max-w-md rounded-lg border border-correction/30 bg-correction-soft p-5 text-center">
            <p className="text-sm text-correction">
              {t("Impossible de charger les niveaux. Vérifiez votre connexion puis réessayez.")}
            </p>
            <button
              type="button"
              onClick={chargerNav}
              className="mt-3 min-h-[44px] rounded-full border border-correction/40 px-4 text-xs font-medium text-correction hover:bg-correction hover:text-paper"
            >
              {t("Réessayer")}
            </button>
          </div>
        )}

        {!nav && !navErreur && <DeckSkeleton />}
        {nav && !niveauActif && (
          <NiveauGrid niveaux={nav.niveaux} onChoose={(n) => setNiveauActif(n)} />
        )}
        {nav && niveauActif && (
          <div className="fade-in grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {(niveauActif.classes ?? []).filter((c) => c.actif).map((c) => {
              const total = c.epreuves;
              return (
                <Link
                  key={c.code}
                  to={`/secondaire/${c.code}`}
                  className="flex min-h-[104px] flex-col justify-between rounded-lg border border-ink-soft/15 bg-paper-raised p-4 text-left transition-colors hover:border-highlight/50 hover:bg-highlight-soft/40 focus-visible:border-highlight/50"
                >
                  <span className="font-serif-brand text-xl">{c.label}</span>
                  <span className="font-mono-tag text-[10px] text-slate">
                    {t(total > 1 ? "{n} épreuves" : "{n} épreuve", { n: total })}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Sélection de niveaux : toutes les cartes sont entièrement visibles, sans
 * superposition. Une carte active (Secondaire) est cliquable ; un niveau
 * inactif (Primaire) reste visible mais verrouillé.
 */
function NiveauGrid({ niveaux, onChoose }: { niveaux: NiveauNav[]; onChoose: (n: NiveauNav) => void }) {
  return (
    <div className="fade-in mx-auto grid max-w-2xl gap-4 sm:grid-cols-2">
      {niveaux.filter((n) => n.actif).map((n) => {
        const description = NIVEAU_DESCRIPTIONS[n.code];
        return (
          <button
            key={n.code}
            type="button"
            onClick={() => onChoose(n)}
            aria-label={t("Consulter le niveau {n}", { n: t(n.label) })}
            className="flex min-h-[140px] w-full flex-col justify-between rounded-lg border border-ink-soft/20 bg-paper-raised p-5 text-left transition-colors hover:border-highlight/60 hover:bg-highlight-soft/40 focus-visible:border-highlight/60"
          >
            <span className="flex items-center gap-3">
              <GraduationCap size={24} strokeWidth={1.5} aria-hidden="true" className="text-highlight-text" />
              <span className="block">
                <span className="block font-serif-brand text-lg">{t(n.label)}</span>
                <span className="block text-xs text-slate">{description ?? `${n.classes.length} classes`}</span>
              </span>
            </span>
            <span className="font-mono-tag text-[10px] text-slate">
              {t("{n} épreuve(s) publiée(s)", { n: n.classes.reduce((acc, c) => acc + c.epreuves, 0) })}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DeckSkeleton() {
  return (
    <div className="mx-auto grid max-w-2xl gap-4 sm:grid-cols-2">
      <div className="skeleton h-[140px] w-full rounded-lg" />
      <div className="skeleton h-[140px] w-full rounded-lg opacity-70" />
    </div>
  );
}
