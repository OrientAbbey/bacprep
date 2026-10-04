import { ArrowLeft, Check, Lock, LockOpen, Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { Consultation, EpreuveListItem, Filtres } from "../api/types";
import { Combobox } from "../components/Combobox";
import { MetaBadge } from "../components/MetaBadge";
import { CatalogueSkeleton } from "../components/Skeleton";
import { classeLabel } from "../lib/referentiel";
import { formatRelativeTime } from "../lib/time";
import { t } from "../i18n";

type CorrigeFiltre = "tous" | "avec" | "sans";
type AccesFiltre = "tous" | "gratuit" | "ouvert" | "payant";

// Nombre d'épreuves chargées par page — évite de charger (et de faire
// rendre) des centaines de cartes d'un coup une fois le catalogue étoffé ;
// "Voir plus" charge la page suivante en l'ajoutant à la liste affichée.
const PAGE_SIZE = 24;

/**
 * Catalogue filtrable, utilisé dans deux contextes :
 * - `/secondaire/:classe` : épreuves PUBLIÉES de la classe sélectionnée
 *   depuis l'accueil, filtres dynamiques (série, matière, année,
 *   évaluation) recalculés pour cette classe ;
 * - `/catalogue?q=...` : résultats d'une RECHERCHE GLOBALE sur tout le
 *   catalogue, indépendamment de la classe (la carte affiche alors la
 *   classe de chaque épreuve).
 */
export function CataloguePage() {
  const navigate = useNavigate();
  const { classe } = useParams<{ classe: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const modeRecherche = query.trim().length > 0;

  const [champRecherche, setChampRecherche] = useState(query);
  useEffect(() => setChampRecherche(query), [query]);

  const [filtres, setFiltres] = useState<Filtres>({ filieres: [], matieres: [], annees: [], evaluations: [] });
  const [epreuves, setEpreuves] = useState<EpreuveListItem[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [erreurSuite, setErreurSuite] = useState(false);
  const [historique, setHistorique] = useState<Consultation[]>([]);

  const [filiere, setFiliere] = useState("");
  const [matiere, setMatiere] = useState("");
  const [annee, setAnnee] = useState("");
  const [evaluation, setEvaluation] = useState("");
  const [corrige, setCorrige] = useState<CorrigeFiltre>("tous");
  const [acces, setAcces] = useState<AccesFiltre>("tous");
  const [initialized, setInitialized] = useState(false);
  const [matieres, setMatieres] = useState<{ matiere: string; total: number; gratuits: number }[] | null>(null);
  // Sans matière choisie ni recherche ni filtre d'accès : une tuile par matière
  // (avec son nombre d'épreuves) plutôt qu'une longue liste mélangée.
  const modeTuiles = !modeRecherche && !matiere && corrige === "tous" && acces === "tous";

  // Filtres dynamiques : recalculés dans le cadre de la classe courante.
  useEffect(() => {
    setInitialized(false);
    const ac = new AbortController();
    const params = new URLSearchParams();
    if (classe) params.set("classe", classe);
    api
      .get<Filtres>(`/api/epreuves/filtres?${params}`, undefined, ac.signal)
      .then((f) => {
        if (ac.signal.aborted) return;
        setFiltres(f);
        setInitialized(true);
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        setInitialized(true);
      });
    // Historique : silencieux si non connecté (catalogue public, 401 inoffensif).
    api
      .get<Consultation[]>("/api/me/historique", undefined, ac.signal)
      .then((h) => {
        if (!ac.signal.aborted) setHistorique(h);
      })
      .catch(() => {});
    setFiliere(""); setMatiere(""); setAnnee(""); setEvaluation("");
    setCorrige("tous"); setAcces("tous");
    return () => ac.abort();
  }, [classe]);

  function buildParams(offset: number): URLSearchParams {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (modeRecherche) {
      // Recherche GLOBALE : la requête serveur ignore volontairement la
      // classe — les autres filtres restent applicables pour affiner.
      params.set("q", query);
    } else if (classe) {
      params.set("classe", classe);
    }
    if (filiere) params.set("filiere", filiere);
    if (matiere) params.set("matiere", matiere);
    if (annee) params.set("annee", annee);
    if (evaluation) params.set("evaluation", evaluation);
    if (corrige !== "tous") params.set("corrige", corrige);
    // "Ouvert" est résolu côté serveur (miroir SQL de store.has_access, avec
    // la session élève si présente) — le filtre s'applique donc AVANT la
    // pagination, contrairement à l'ancienne version qui filtrait côté
    // client après coup (une page pouvait afficher moins de cartes).
    if (acces !== "tous") params.set("acces_type", acces);
    return params;
  }

  useEffect(() => {
    if (!initialized || !modeTuiles) return;
    const ac = new AbortController();
    const params = new URLSearchParams();
    if (classe) params.set("classe", classe);
    if (filiere) params.set("filiere", filiere);
    if (annee) params.set("annee", annee);
    if (evaluation) params.set("evaluation", evaluation);
    setMatieres(null);
    api
      .get<{ matiere: string; total: number; gratuits: number }[]>(`/api/epreuves/matieres?${params}`, undefined, ac.signal)
      .then((m) => !ac.signal.aborted && setMatieres(m))
      .catch(() => !ac.signal.aborted && setMatieres([]));
    return () => ac.abort();
  }, [initialized, modeTuiles, classe, filiere, annee, evaluation]);

  // Séquence des requêtes de liste : le dernier appel gagne. Une réponse
  // portant un jeton périmé ne peut plus écraser (première page) ni
  // concaténer (« Voir plus ») une liste qui correspond à d'autres filtres.
  const seqRef = useRef(0);

  /** Signature de la requête courante : tous les filtres SAUF la pagination.
   * Permet de refuser une réponse dont les filtres ne sont plus ceux-là. */
  function signatureFiltres(): string {
    const params = buildParams(0);
    params.delete("limit");
    params.delete("offset");
    return params.toString();
  }

  // Recharge la première page à chaque changement de filtre/requête
  // (effet) ou au clic sur « Réessayer ». AbortController + jeton de
  // séquence : une réponse d'un filtre périmé ne peut plus écraser la liste
  // courante (courses de réponses).
  async function loadFirstPage(signal?: AbortSignal) {
    const jeton = ++seqRef.current;
    if (modeTuiles) {
      setEpreuves([]);
      setHasMore(false);
      setChargement(false);
      return;
    }
    setChargement(true);
    setErreur(false);
    try {
      const page = await api.get<EpreuveListItem[]>(`/api/epreuves?${buildParams(0)}`, undefined, signal);
      if (signal?.aborted || jeton !== seqRef.current) return;
      setEpreuves(page);
      setHasMore(page.length === PAGE_SIZE);
      setChargement(false);
    } catch (err) {
      if (signal?.aborted || jeton !== seqRef.current) return;
      setErreur(true);
      setChargement(false);
      // L'utilisateur voit déjà le bandeau « Le catalogue n'a pas pu être
      // chargé » avec un bouton Réessayer — pas de double log console ici.
    }
  }

  useEffect(() => {
    if (!initialized) return;
    const ac = new AbortController();
    loadFirstPage(ac.signal);
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filiere, matiere, annee, evaluation, corrige, acces, initialized, query]);

  async function loadMore() {
    // Deux clics rapprochés partiraient sur le même `epreuves.length` et
    // concaténeraient deux fois la même page.
    if (loadingMore) return;
    setErreurSuite(false);
    setLoadingMore(true);
    // Filtres et numéro de page figés AU MOMENT du clic : la réponse n'est
    // acceptée que si l'utilisateur n'a rien changé d'ici là.
    const jeton = ++seqRef.current;
    const signature = signatureFiltres();
    const offset = epreuves.length;
    try {
      const page = await api.get<EpreuveListItem[]>(`/api/epreuves?${buildParams(offset)}`);
      if (jeton !== seqRef.current || signature !== signatureFiltres()) return;
      setEpreuves((prev) => [...prev, ...page]);
      setHasMore(page.length === PAGE_SIZE);
    } catch {
      if (jeton !== seqRef.current) return;
      // "Voir plus" échoué : on garde la liste déjà affichée, l'utilisateur
      // peut relancer — mais pas de concaténation de résultats périmés.
      setHasMore(true);
      setErreurSuite(true);
    } finally {
      if (jeton === seqRef.current) setLoadingMore(false);
    }
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = champRecherche.trim();
    if (q) navigate(`/catalogue?q=${encodeURIComponent(q)}`);
    else if (modeRecherche) navigate("/");
  }

  const historiqueMap = useMemo(() => new Map(historique.map((h) => [h.epreuve_id, h])), [historique]);

  function openEpreuve(e: EpreuveListItem) {
    // "Ouvert" (déjà couvert par un abonnement actif) se comporte comme
    // "gratuit" pour la navigation : accès direct au lecteur, pas de
    // redirection vers la page d'abonnement.
    if (e.acces === "payant") {
      navigate(`/abonnement?epreuve_id=${e.id}`);
      return;
    }
    navigate(`/epreuve/${e.id}`);
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          {modeRecherche ? (
            <>
              <h1 className="font-serif-brand text-2xl">{t("Recherche dans tout le catalogue")}</h1>
              <p className="text-sm text-ink-soft">
                {t("Résultats pour «\u00a0{q}\u00a0» — toutes classes confondues.", { q: query })}
              </p>
            </>
          ) : (
            <>
              <h1 className="font-serif-brand text-2xl">Classe de {classeLabel(classe ?? "")}</h1>
              <p className="text-sm text-ink-soft">
                {t("Épreuves publiées — filtre par série, matière, année et évaluation.")}
              </p>
            </>
          )}
        </div>
        <button
          onClick={() => navigate("/")}
          className="flex min-h-[40px] items-center gap-2 rounded-full border border-ink-soft/25 px-4 text-sm hover:bg-highlight-soft/40"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          {t("Accueil")}
        </button>
      </div>

      {/* Recherche globale : accessible depuis le catalogue, indépendamment
          de la classe courante (prompt d'amélioration §3). */}
      <form onSubmit={submitSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search
            size={18}
            strokeWidth={1.75}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate"
          />
          <input
            value={champRecherche}
            onChange={(e) => setChampRecherche(e.target.value)}
            placeholder={t("Rechercher dans tout le catalogue (matière, série, examen…)")}
            aria-label={t("Recherche globale")}
            className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised pl-10 pr-4 text-sm"
          />
        </div>
        <button type="submit" className="min-h-[44px] rounded-full bg-ink px-5 text-sm font-medium text-paper">
          {t("Rechercher")}
        </button>
      </form>

      <div className="flex flex-wrap gap-4">
        <Combobox
          label={t("Série")}
          value={filiere}
          onChange={setFiliere}
          options={filtres.filieres.map((f) => ({ value: f, label: f }))}
        />
        <Combobox
          label={t("Matière")}
          value={matiere}
          onChange={setMatiere}
          options={filtres.matieres.map((m) => ({ value: m, label: m }))}
        />
        <Combobox
          label={t("Année")}
          value={annee}
          onChange={setAnnee}
          options={filtres.annees.map((a) => ({ value: a, label: a }))}
        />
        <Combobox
          label="Évaluation"
          value={evaluation}
          onChange={setEvaluation}
          options={filtres.evaluations.map((ev) => ({ value: ev, label: ev }))}
        />
      </div>

      {/* Un libellé unique par groupe (pas répété sur chaque bouton) ;
          les boutons ne portent que la valeur capitalisée. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
        <span className="font-mono-tag text-[10px] text-ink-soft">{t("Corrigé")}</span>
        <div role="group" aria-label={t("Filtre par disponibilité du corrigé")} className="flex gap-1 rounded-full border border-ink-soft/20 p-1 font-mono-tag text-[10px]">
          {([["tous", "Tous"], ["avec", "Avec"], ["sans", "Sans"]] as [CorrigeFiltre, string][]).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setCorrige(v)}
              aria-pressed={corrige === v}
              className={`min-h-[44px] rounded-full px-3 py-1.5 ${corrige === v ? "bg-ink text-paper" : "text-ink-soft"}`}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <span className="font-mono-tag text-[10px] text-ink-soft">{t("Accès")}</span>
        <div role="group" aria-label={t("Filtre par type d'accès")} className="flex gap-1 rounded-full border border-ink-soft/20 p-1 font-mono-tag text-[10px]">
          {([["tous", "Tous"], ["gratuit", "Gratuit"], ["ouvert", "Ouvert"], ["payant", "Payant"]] as [AccesFiltre, string][]).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setAcces(v)}
              aria-pressed={acces === v}
              className={`min-h-[44px] rounded-full px-3 py-1.5 ${acces === v ? "bg-ink text-paper" : "text-ink-soft"}`}
            >
              {t(label)}
            </button>
          ))}
        </div>
      </div>

      {historique.length > 0 && !modeRecherche && (
        <section>
          <h2 className="mb-2 font-mono-tag text-xs text-ink-soft">{t("Consultées récemment")}</h2>
          <div className="scrollbar-hide flex gap-3 overflow-x-auto pb-2">
            {historique.map((h) => (
              <button
                key={h.epreuve_id}
                onClick={() => navigate(`/epreuve/${h.epreuve_id}`)}
                aria-label={t("Épreuve de {matiere}, {detail}", { matiere: h.matiere, detail: `${h.classe ? `${classeLabel(h.classe)} ` : ""}${h.annee}` })}
                className="min-w-[180px] shrink-0 rounded-lg border border-ink-soft/15 bg-paper-raised p-3 text-left transition-colors hover:border-highlight/50 hover:bg-highlight-soft/40 focus-visible:border-highlight/50"
              >
                <span className="block font-serif-brand text-sm">{h.matiere}</span>
                <span className="block font-mono-tag text-[10px] text-slate">
                  {h.classe ? `${classeLabel(h.classe)} · ` : ""}
                  {h.filieres.join(",")} · {h.annee}
                </span>
                <span className="mt-0.5 block text-xs text-slate">{formatRelativeTime(h.consulted_at)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section aria-label={modeRecherche ? "Résultats de recherche" : "Épreuves"} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <h2 className="col-span-full font-mono-tag text-xs text-ink-soft">
          {modeRecherche ? t("RÉSULTATS") : modeTuiles ? t("MATIÈRES") : t("ÉPREUVES")}
        </h2>
        {!modeRecherche && matiere && (
          <button
            type="button"
            onClick={() => setMatiere("")}
            className="col-span-full min-h-[44px] w-fit text-left text-sm text-ink-soft underline"
          >
            ← Toutes les matières · <strong className="font-medium">{matiere}</strong>
          </button>
        )}
        {modeTuiles && matieres === null && (
          <div className="col-span-full">
            <CatalogueSkeleton count={6} />
          </div>
        )}
        {modeTuiles &&
          matieres?.map((m) => (
            <button
              key={m.matiere}
              type="button"
              onClick={() => setMatiere(m.matiere)}
              className="flex flex-col gap-1 rounded-lg border border-ink-soft/15 bg-paper-raised p-4 text-left transition-colors hover:border-highlight/50 hover:bg-highlight-soft/40 focus-visible:border-highlight/50"
            >
              <span className="font-serif-brand text-lg leading-snug">{m.matiere}</span>
              <span className="font-mono-tag text-[11px] text-slate">
                {t(m.total > 1 ? "{n} épreuves" : "{n} épreuve", { n: m.total })}
                {m.gratuits > 0 ? ` · ${t(m.gratuits > 1 ? "{n} gratuites" : "{n} gratuite", { n: m.gratuits })}` : ""}
              </span>
            </button>
          ))}
        {modeTuiles && matieres?.length === 0 && (
          <p className="col-span-full text-sm text-slate">{t("Aucune épreuve ne correspond à ces filtres.")}</p>
        )}
        {erreur && !chargement && (
          <div role="alert" className="col-span-full rounded-lg border border-correction/30 bg-correction-soft p-4 text-correction">
            Le catalogue n'a pas pu être chargé.{" "}
            <button
              type="button"
              onClick={() => loadFirstPage()}
              className="underline"
            >
              {t("Réessayer")}
            </button>
          </div>
        )}
        {chargement && (
          <div className="col-span-full">
            <CatalogueSkeleton />
          </div>
        )}
        {!chargement && epreuves.map((e, i) => {
          // Une matière choisie : la liste (déjà triée par année) est coupée
          // par un en-tête d'année.
          const enteteAnnee = !modeRecherche && Boolean(matiere) && e.annee !== epreuves[i - 1]?.annee;
          return (
            <Fragment key={e.id}>
              {enteteAnnee && (
                <h3 className="col-span-full mt-2 border-b border-ink-soft/15 pb-1 font-mono-tag text-xs text-ink-soft">{e.annee}</h3>
              )}
            <button
              onClick={() => openEpreuve(e)}
              aria-label={t("Épreuve de {matiere}, {detail}", { matiere: e.matiere, detail: `${e.evaluation} ${e.annee}` })}
              className="flex flex-col gap-2 rounded-lg border border-ink-soft/15 bg-paper-raised p-4 text-left transition-colors hover:border-highlight/50 hover:bg-highlight-soft/40 focus-visible:border-highlight/50"
            >
              <span className="flex items-start justify-between gap-2">
                <span className="block font-serif-brand text-lg leading-snug">{e.matiere}</span>
                {e.acces === "gratuit" && (
                  <MetaBadge variant="pill" tone="valide" title={t("Contenu gratuit de découverte")}>
                    {t("Gratuit")}
                  </MetaBadge>
                )}
                {e.acces === "ouvert" && (
                  <MetaBadge variant="pill" tone="valide" title={t("Déjà débloquée par ton abonnement")}>
                    <LockOpen size={12} strokeWidth={2} aria-hidden="true" />
                    {t("Ouvert")}
                  </MetaBadge>
                )}
                {e.acces === "payant" && (
                  <MetaBadge variant="pill" tone="correction" title={t("Abonnement requis")}>
                    <Lock size={12} strokeWidth={2} aria-hidden="true" />
                    {t("Payant")}
                  </MetaBadge>
                )}
              </span>

              <span className="block font-mono-tag text-[11px] text-slate">
                {e.evaluation} {e.annee}
                {modeRecherche ? ` · ${classeLabel(e.classe)}` : ""}
                {e.duree ? ` · ${e.duree}` : ""}
              </span>

              {/* Extrait du sujet (2 lignes max) : donne un aperçu du
                  contenu avant d'ouvrir l'épreuve. */}
              {e.extrait && <span className="block line-clamp-2 text-xs text-ink-soft">{e.extrait}</span>}

              {/* Un seul badge pour l'ensemble des séries (ex. "A,C,E") plutôt
                  qu'un badge par série. Le badge "corrigé" combine icône ET
                  texte court. */}
              <span className="flex flex-wrap items-center gap-1.5">
                <MetaBadge>{e.filieres.join(",")}</MetaBadge>
                {e.corrige_disponible && (
                  <MetaBadge tone="valide" title={t("Le corrigé de cette épreuve est disponible")}>
                    <Check size={12} strokeWidth={2} aria-hidden="true" />
                    {t("Corrigé")}
                  </MetaBadge>
                )}
              </span>

              {historiqueMap.has(e.id) && (
                <span className="block text-xs text-slate">
                  Consulté {formatRelativeTime(historiqueMap.get(e.id)!.consulted_at)}
                </span>
              )}
            </button>
            </Fragment>
          );
        })}

        {!chargement && !modeTuiles && epreuves.length === 0 && initialized && (
          <p className="col-span-full text-sm text-slate">
            {modeRecherche
              ? t("Aucune épreuve ne correspond à cette recherche.")
              : t("Aucune épreuve ne correspond à ces filtres.")}
          </p>
        )}
      </section>

      {erreurSuite && (
        <div role="alert" className="flex items-center justify-center gap-3 text-sm text-correction">
          <span>{t("Le chargement des épreuves supplémentaires a échoué.")}</span>
          <button
            type="button"
            onClick={loadMore}
            className="underline"
          >
            {t("Réessayer")}
          </button>
        </div>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="min-h-[40px] rounded-full border border-ink-soft/25 px-6 text-sm disabled:opacity-50"
          >
            {loadingMore ? "Chargement…" : "Voir plus"}
          </button>
        </div>
      )}
    </div>
  );
}
