import { BookOpen, Calendar, CheckCircle2, GraduationCap, Layers } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { EpreuveListItem, Filtres } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Combobox } from "../components/Combobox";
import { Skeleton } from "../components/Skeleton";
import { CLASSES_SECONDAIRE, classeLabel } from "../lib/referentiel";
import { foldText } from "../lib/text";

/** Fait défiler doucement un élément nouvellement apparu dans le champ de
 * vision (respecte prefers-reduced-motion : déplacement instantané). */
function scrollIntoViewDoucement(el: HTMLElement | null) {
  if (!el) return;
  const reduced =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
}

type Scope = "epreuve" | "matiere_annee" | "matiere" | "annee" | "filiere";

interface Pricing {
  pricing: Record<Scope, number>;
  labels: Record<Scope, string>;
  descriptions: Record<Scope, string>;
  duree_jours: number;
}

const SCOPES: Scope[] = ["epreuve", "matiere_annee", "matiere", "annee", "filiere"];

/** Champs de sélection requis par scope, et leur traduction en paramètre
 * API — SOURCE DE VÉRITÉ UNIQUE pour le garde anti-course du compte
 * d'épreuves ET la complétude de la sélection (ajouter un scope ou un
 * champ ne se fait plus qu'à un seul endroit). La portée "epreuve" transmet
 * `epreuve_id` au lieu de classe/série (toute portée large est achetée
 * DANS LE CADRE D'UNE CLASSE). */
const CHAMPS_PAR_SCOPE: Record<Scope, Record<string, string>> = {
  epreuve: { epreuveId: "epreuve_id" },
  matiere_annee: { classe: "classe", filiere: "filiere", matiere: "matiere", annee: "annee" },
  matiere: { classe: "classe", filiere: "filiere", matiere: "matiere" },
  annee: { classe: "classe", filiere: "filiere", annee: "annee" },
  filiere: { classe: "classe", filiere: "filiere" },
};
const PROVIDERS = [
  { value: "orange", label: "Orange Money" },
  { value: "mtn", label: "MTN Mobile Money" },
];

/**
 * Page de souscription. Le type d'abonnement (scope) se choisit en
 * premier (grille de cartes : libellé, prix, description) ; la classe
 * (requise pour toute portée autre que "épreuve précise" — un abonnement
 * est acheté dans le cadre d'une classe), la série, et le cas échéant
 * matière/année en découlent.
 *
 * La page est PUBLIQUE (pattern Stripe/Notion : on présente l'offre à
 * tout le monde) ; seule la souscription exige un compte — le visiteur
 * est renvoyé vers la connexion avec retour automatique.
 *
 * Deux garde-fous empêchent de proposer un paiement pour un contenu déjà
 * accessible :
 * - les épreuves déjà gratuites sont retirées de la liste "Épreuve
 *   précise" (s'y abonner n'apporterait rien) ;
 * - à chaque changement de sélection, `GET /api/subscriptions/deja-couvert`
 *   est interrogé ; s'il répond `true`, le moyen de paiement est masqué et
 *   remplacé par un message explicite (garde-fou dupliqué côté serveur).
 */
export function SubscribePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [filtres, setFiltres] = useState<Filtres>({ filieres: [], matieres: [], annees: [], evaluations: [] });
  const [epreuves, setEpreuves] = useState<EpreuveListItem[]>([]);

  const [scope, setScope] = useState<Scope>("epreuve");
  const [classe, setClasse] = useState("");
  const [filiere, setFiliere] = useState("");
  const [matiere, setMatiere] = useState("");
  const [annee, setAnnee] = useState("");
  const [epreuveId, setEpreuveId] = useState("");
  const [epreuveSearch, setEpreuveSearch] = useState("");
  const [provider, setProvider] = useState("orange");
  const [count, setCount] = useState<number | null>(null);
  const [dejaCouvert, setDejaCouvert] = useState(false);
  const [step, setStep] = useState<"form" | "pending" | "confirmed">("form");
  const [reference, setReference] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [erreurPricing, setErreurPricing] = useState(false);

  const chargerTarifs = useCallback(() => {
    setErreurPricing(false);
    api.get<Pricing>("/api/pricing").then(setPricing).catch(() => setErreurPricing(true));
  }, []);

  useEffect(() => {
    chargerTarifs();
    // limit=100 (plafond serveur) : la page n'a besoin que du libellé des
    // épreuves proposables — charger TOUT le catalogue était incohérent
    // avec le catalogue paginé à 24.
    api.get<EpreuveListItem[]>("/api/epreuves?limit=100").then(setEpreuves).catch(() => {});

    // Préremplissage depuis le catalogue (clic sur une épreuve verrouillée)
    const pre = searchParams.get("epreuve_id");
    if (pre) {
      setScope("epreuve");
      setEpreuveId(pre);
    }
  }, [searchParams, chargerTarifs]);

  // Filtres dynamiques dans le cadre de la classe choisie.
  useEffect(() => {
    const params = classe ? `?classe=${encodeURIComponent(classe)}` : "";
    // Silence volontaire : filtres secondaires, la page reste utilisable
    // avec des listes vides (message explicite déjà en place côté UI).
    api.get<Filtres>(`/api/epreuves/filtres${params}`).then(setFiltres).catch(() => {});
  }, [classe]);

  const selectedEpreuve = epreuves.find((e) => e.id === epreuveId);

  /** Épreuves proposables à l'abonnement "épreuve précise" : on retire
   * celles déjà gratuites (s'y abonner ne débloquerait rien de plus) et on
   * applique la recherche tapée par l'utilisateur. */
  const epreuvesFiltrees = useMemo(() => {
    const abonnables = epreuves.filter((e) => !e.gratuit);
    if (!epreuveSearch.trim()) return abonnables;
    const q = foldText(epreuveSearch);
    return abonnables.filter((e) => foldText(e.matiere).includes(q) || e.annee.includes(q));
  }, [epreuves, epreuveSearch]);

  // Valeurs courantes des champs de sélection, indexables par nom de champ
  // (cf. CHAMPS_PAR_SCOPE) — redériver des états listés dans les deps.
  const selection: Record<string, string> = { epreuveId, classe, filiere, matiere, annee };

  useEffect(() => {
    // Garde anti-course : les deux requêtes s'enchaînent en await — changer
    // de scope/classe/filière entre-temps ne doit pas afficher le
    // count/dejaCouvert d'une sélection antérieure (page de paiement !).
    let stale = false;
    async function refresh() {
      const complete = Object.keys(CHAMPS_PAR_SCOPE[scope]).every((champ) => Boolean(selection[champ]));
      if (!complete) {
        setCount(null);
        setDejaCouvert(false);
        return;
      }
      const baseParams: Record<string, string> = {};
      for (const [champ, param] of Object.entries(CHAMPS_PAR_SCOPE[scope])) {
        baseParams[param] = selection[champ];
      }

      const countParams = new URLSearchParams(baseParams);
      const countRes = await api.get<{ count: number }>(`/api/epreuves/count?${countParams.toString()}`);
      if (stale) return;
      setCount(countRes.count);

      const couvertParams = new URLSearchParams({ scope, ...baseParams });
      const couvertRes = await api.get<{ deja_couvert: boolean }>(
        `/api/subscriptions/deja-couvert?${couvertParams.toString()}`
      );
      if (stale) return;
      setDejaCouvert(couvertRes.deja_couvert);
    }
    // Silence volontaire : count/dejaCouvert sont des indications
    // secondaires d'interface — le checkout re-vérifie côté serveur.
    refresh().catch(() => {});
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, classe, filiere, matiere, annee, epreuveId]);

  const selectionComplete = Object.keys(CHAMPS_PAR_SCOPE[scope]).every((champ) => Boolean(selection[champ]));

  // Quand la carte récapitulative apparaît (sélection devenue complète) ou
  // grandit au fil des choix, on l'amène doucement dans le champ de vision —
  // sans ça, elle naissait SOUS le pli et l'élève devait chercher le scroll.
  const recapRef = useRef<HTMLDivElement>(null);
  const scopeGroupRef = useRef<HTMLDivElement>(null);
  const pendingTitleRef = useRef<HTMLParagraphElement>(null);
  const confirmedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectionComplete) scrollIntoViewDoucement(recapRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionComplete, scope, classe, filiere, matiere, annee, epreuveId]);

  // Navigation clavier du radiogroup (WAI-ARIA) : flèches et Home/End
  // déplacent sélection ET focus ; seul le bouton sélectionné reste dans
  // l'ordre de tabulation (roving tabIndex).
  function handleScopeKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const radios = Array.from(
      scopeGroupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []
    );
    const index = radios.findIndex((el) => el === document.activeElement);
    if (index === -1) return;
    let next = index;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = (index + 1) % radios.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = (index - 1 + radios.length) % radios.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = radios.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    setScope(SCOPES[next]);
    radios[next]?.focus();
  }

  // Quand on change d'étape, l'ancien panneau (et son déclencheur dispa-
  // raissant) retirait le focus, qui retombait au body : on le ramène sur
  // le panneau nouvellement rendu.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (step === "pending") pendingTitleRef.current?.focus({ preventScroll: true });
      else if (step === "confirmed") confirmedRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [step]);

  /** Phrase de synthèse en langage naturel décrivant ce que la sélection
   * courante débloque — accompagne (sans le remplacer) le détail en
   * tuiles ci-dessous. */
  function summarySentence(): string {
    if (scope === "epreuve" && selectedEpreuve) {
      return `Débloque le sujet${selectedEpreuve.corrige_disponible ? " et le corrigé" : ""} de ${selectedEpreuve.matiere} — ${selectedEpreuve.annee}.`;
    }
    const ctx = classe ? ` (classe de ${classeLabel(classe)})` : "";
    if (scope === "matiere_annee") {
      return `Débloque toutes les épreuves de ${matiere || "…"} pour l'année ${annee || "…"}, série ${filiere || "…"}${ctx}.`;
    }
    if (scope === "matiere") {
      return `Débloque toutes les épreuves de ${matiere || "…"} (toutes années), série ${filiere || "…"}${ctx}.`;
    }
    if (scope === "annee") {
      return `Débloque toutes les épreuves de l'année ${annee || "…"} (toutes matières), série ${filiere || "…"}${ctx}.`;
    }
    return `Débloque tout le contenu de la série ${filiere || "…"} en ${classe ? classeLabel(classe) : "…"} — toutes matières, toutes années.`;
  }

  /** Lance le paiement simulé pour la sélection courante. Le backend
   * refuse (409) si la sélection est en réalité déjà couverte. */
  async function startCheckout() {
    setErreur(null);
    try {
      const res = await api.post<{ reference_agregateur: string }>("/api/subscriptions/checkout", {
        scope,
        classe: scope === "epreuve" ? undefined : classe,
        filiere: scope === "epreuve" ? undefined : filiere,
        matiere: ["matiere_annee", "matiere"].includes(scope) ? matiere : undefined,
        annee: ["matiere_annee", "annee"].includes(scope) ? annee : undefined,
        epreuve_id: scope === "epreuve" ? epreuveId : undefined,
        provider,
      });
      setReference(res.reference_agregateur);
      setStep("pending");
    } catch {
      setErreur("Cette sélection est déjà accessible, ou une erreur est survenue — réessaie.");
    }
  }

  async function simulatePayment() {
    if (!reference) return;
    try {
      await api.post("/api/payments/simulate-webhook", { reference_agregateur: reference });
      setStep("confirmed");
    } catch {
      setErreur("La confirmation du paiement a échoué — réessaie.");
    }
  }

  if (erreurPricing) {
    return (
<div
        role="alert"
        className="rounded-lg border border-correction/30 bg-correction-soft p-6 text-correction"
      >
        La grille tarifaire n'a pas pu être chargée.{" "}
        <button type="button" onClick={chargerTarifs} className="underline">
          Réessayer
        </button>
      </div>
    );
  }

  if (!pricing)
    return (
      <div className="space-y-6" aria-busy="true">
        <Skeleton className="h-8 w-40" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
        <div className="space-y-3 rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      </div>
    );

  return (
    <div className="space-y-6">
      <h1 className="font-serif-brand text-2xl">S'abonner</h1>

      {step === "confirmed" ? (
        <div
          ref={confirmedRef}
          tabIndex={-1}
          className="space-y-4 rounded-lg border border-valide/30 bg-valide-soft p-6 text-valide"
        >
          <p className="font-medium">Paiement confirmé — ton abonnement est actif.</p>
          <div className="flex flex-wrap gap-2">
            {scope === "epreuve" && epreuveId ? (
              <Link
                to={`/epreuve/${epreuveId}`}
                className="min-h-[40px] rounded-full bg-valide px-4 py-2 text-sm font-medium text-paper"
              >
                Ouvrir l'épreuve
              </Link>
            ) : (
              <Link
                to="/catalogue"
                className="min-h-[40px] rounded-full bg-valide px-4 py-2 text-sm font-medium text-paper"
              >
                Voir le catalogue
              </Link>
            )}
            <Link
              to="/profil"
              className="min-h-[40px] rounded-full border border-valide/40 px-4 py-2 text-sm font-medium text-valide"
            >
              Aller à mon profil
            </Link>
          </div>
        </div>
      ) : step === "pending" ? (
        // text-ink (pas text-highlight-ink) : highlight-ink est un token
        // FIXE pensé pour du texte sur le fond `highlight` (jaune vif) qui
        // ne change pas de teinte — posé ici sur `highlight-soft` (qui,
        // lui, s'assombrit fortement en mode sombre), il devenait
        // quasiment illisible (texte très sombre sur fond très sombre).
        <div className="space-y-4 rounded-lg border border-highlight/30 bg-highlight-soft p-6">
          <p ref={pendingTitleRef} tabIndex={-1} className="text-ink">
            Paiement en attente — référence <span className="font-mono-tag">{reference}</span>.
            Dans une vraie intégration, tu confirmerais via Orange Money / MTN MoMo. Ici, simule la
            confirmation :
          </p>
          <button
            onClick={simulatePayment}
            className="min-h-[44px] rounded-full bg-ink px-5 text-sm font-medium text-paper"
          >
            Simuler la confirmation du paiement
          </button>
        </div>
      ) : (
        // Deux colonnes sur lg : sélecteur de plans à gauche, récap de
        // commande (prix + moyens de paiement) à droite, sticky — le
        // récap suit l'élève pendant qu'il affine sa sélection.
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
          <div className="min-w-0 space-y-6">
          {/* Le type d'abonnement se choisit dans une grille de cartes :
              libellé + prix + description (le tarif le plus lisible en
              un coup d'œil, au lieu de pills compactes). */}
          <div
            ref={scopeGroupRef}
            role="radiogroup"
            aria-label="Type d'abonnement"
            onKeyDown={handleScopeKeyDown}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          >
            {SCOPES.map((s) => {
              const actif = scope === s;
              return (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={actif}
                  tabIndex={actif ? 0 : -1}
                  onClick={() => setScope(s)}
                  className={`flex flex-col rounded-lg border p-4 text-left transition-colors ${
                    actif
                      ? "border-highlight bg-highlight-soft/40"
                      : "border-ink-soft/20 bg-paper-raised hover:border-highlight/50"
                  } focus-visible:border-highlight`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-serif-brand text-base">{pricing.labels[s]}</span>
                    {actif && <CheckCircle2 size={16} strokeWidth={2} aria-hidden="true" className="text-highlight" />}
                  </span>
                  <span className={`mt-1 font-mono-tag text-sm ${actif ? "text-ink" : "text-ink-soft"}`}>
                    {pricing.pricing[s]} FCFA
                    <span className="text-[10px] text-slate"> / {pricing.duree_jours} j</span>
                  </span>
                  <span className="mt-1.5 text-xs text-slate">{pricing.descriptions?.[s]}</span>
                </button>
              );
            })}
          </div>

          {scope === "epreuve" ? (
            <Combobox
              label="Épreuve"
              value={epreuveId}
              onChange={setEpreuveId}
              options={epreuvesFiltrees.map((e) => ({
                value: e.id,
                label: `${e.matiere} — ${e.annee} (${e.filieres.join(", ")})`,
              }))}
            />
          ) : (
            <div className="flex flex-wrap gap-4">
              <Combobox
                label="Classe"
                value={classe}
                onChange={setClasse}
                options={CLASSES_SECONDAIRE.map((c) => ({ value: c.code, label: c.label }))}
              />
              <Combobox
                label="Série"
                value={filiere}
                onChange={setFiliere}
                options={filtres.filieres.map((f) => ({ value: f, label: f }))}
              />
              {["matiere_annee", "matiere"].includes(scope) && (
                <Combobox
                  label="Matière"
                  value={matiere}
                  onChange={setMatiere}
                  options={filtres.matieres.map((m) => ({ value: m, label: m }))}
                />
              )}
              {["matiere_annee", "annee"].includes(scope) && (
                <Combobox
                  label="Année"
                  value={annee}
                  onChange={setAnnee}
                  options={filtres.annees.map((a) => ({ value: a, label: a }))}
                />
              )}
            </div>
          )}
          </div>

          {/* Colonne récapitulative : sticky, elle suit la sélection. */}
          <aside className="min-w-0 space-y-6 lg:sticky lg:top-24">
          {/* Carte récapitulative : bandeau prix mis en avant, phrase de
              synthèse, puis le détail en tuiles à icônes. Elle est amenée
              dans le champ de vision dès qu'elle apparaît (voir effet
              `recapRef` ci-dessus). */}
          {selectionComplete && (
            <div ref={recapRef} className="overflow-hidden rounded-lg border border-ink-soft/15 bg-paper-raised shadow-sm">
              <div className="bg-highlight-soft px-6 py-5 text-center">
                <p className="font-mono-tag text-[10px] text-ink-soft">Prix de l'abonnement</p>
                <p className="font-serif-brand text-4xl text-ink">
                  {pricing.pricing[scope]} <span className="text-lg font-sans font-normal text-ink-soft">FCFA</span>
                </p>
                <p className="text-xs text-ink-soft">valable {pricing.duree_jours} jours</p>
                {/* Description lisible de la portée choisie (2 lignes max),
                    fournie par le backend — même vocabulaire partout. */}
                {pricing.descriptions?.[scope] && (
                  <p className="mx-auto mt-2 max-w-sm text-xs text-ink-soft">{pricing.descriptions[scope]}</p>
                )}
              </div>

              <div className="space-y-4 p-5">
                <p className="text-sm text-ink-soft">{summarySentence()}</p>

                <div className="grid grid-cols-2 gap-3">
                  {scope !== "epreuve" && <InfoTile icon={GraduationCap} label="Classe" value={classe ? classeLabel(classe) : "—"} />}
                  {scope !== "epreuve" && <InfoTile icon={GraduationCap} label="Série" value={filiere || "—"} />}
                  {scope === "epreuve" && selectedEpreuve && (
                    <InfoTile icon={GraduationCap} label="Séries" value={selectedEpreuve.filieres.join(", ")} />
                  )}
                  {["matiere_annee", "matiere"].includes(scope) && (
                    <InfoTile icon={BookOpen} label="Matière" value={matiere || "—"} />
                  )}
                  {scope === "epreuve" && selectedEpreuve && (
                    <InfoTile icon={BookOpen} label="Matière" value={selectedEpreuve.matiere} />
                  )}
                  {["matiere_annee", "annee"].includes(scope) && (
                    <InfoTile icon={Calendar} label="Année" value={annee || "—"} />
                  )}
                  {scope === "epreuve" && selectedEpreuve && (
                    <InfoTile icon={Calendar} label="Année" value={selectedEpreuve.annee} />
                  )}
                  <InfoTile icon={Layers} label="Épreuves couvertes" value={String(count ?? "…")} />
                </div>

                {erreur && (
                  <p role="alert" className="text-sm text-correction">
                    {erreur}
                  </p>
                )}

                {/* Révélation progressive : moyen de paiement uniquement si
                    la sélection couvre au moins une épreuve ET n'est pas
                    déjà entièrement accessible (gratuite ou déjà abonnée).
                    Visiteur : la souscription exige un compte — CTA de
                    connexion avec retour automatique vers cette page. */}
                {count !== null && count > 0 && !dejaCouvert ? (
                  !user ? (
                    <div className="space-y-3 border-t border-dashed border-ink-soft/20 pt-4">
                      <p className="text-sm text-ink-soft">
                        La souscription nécessite un compte — tes abonnements suivent ton profil.
                      </p>
                      <button
                        type="button"
                        onClick={() => navigate("/connexion", { state: { from: location } })}
                        className="min-h-[44px] w-full rounded-full bg-ink text-sm font-medium text-paper hover:opacity-90"
                      >
                        Se connecter pour souscrire
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3 border-t border-dashed border-ink-soft/20 pt-4">
                      <div className="flex gap-2">
                        {PROVIDERS.map((p) => (
                          <button
                            key={p.value}
                            onClick={() => setProvider(p.value)}
                            aria-pressed={provider === p.value}
                            className={`flex items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors ${
                              provider === p.value
                                ? "border-ink"
                                : "border-ink-soft/20 text-ink-soft hover:border-ink-soft/50"
                            }`}
                          >
                            <span
                              className={`h-2.5 w-2.5 rounded-full ${p.value === "orange" ? "bg-highlight" : "bg-valide"}`}
                            />
                            {p.label}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={startCheckout}
                        className="min-h-[44px] w-full rounded-full bg-ink text-sm font-medium text-paper"
                      >
                        Continuer vers le paiement
                      </button>
                    </div>
                  )
                ) : count !== null && dejaCouvert ? (
                  <p className="border-t border-dashed border-ink-soft/20 pt-4 text-sm text-valide">
                    Tu as déjà accès à ce contenu (gratuit ou déjà couvert par un abonnement actif) —
                    aucun paiement nécessaire.
                  </p>
                ) : (
                  count !== null && (
                    <p className="border-t border-dashed border-ink-soft/20 pt-4 text-sm text-correction">
                      Cette combinaison ne couvre aucune épreuve publiée pour l'instant — ajuste ta
                      sélection.
                    </p>
                  )
                )}
              </div>
            </div>
          )}
          </aside>
          </div>
      )}
    </div>
  );
}

/** Tuile icône + libellé + valeur du récapitulatif d'abonnement — remplace
 * l'ancien tableau à deux colonnes, trop dense et peu visuel. */
function InfoTile({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-ink-soft/15 bg-paper p-3">
      <Icon size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-highlight" />
      <div className="min-w-0">
        <p className="font-mono-tag text-[10px] text-ink-soft">{label}</p>
        <p className="truncate text-sm font-medium text-ink">{value}</p>
      </div>
    </div>
  );
}
