import { ChevronRight, ClipboardCheck, FileText, Flag, Lock } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { EpreuveDetail } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { AssistantLauncherButton } from "../components/AssistantLauncherButton";
import { AssistantPanel, PasteSignal } from "../components/AssistantPanel";
import { Chronometre } from "../components/Chronometre";
import { MarkdownContent } from "../components/MarkdownContent";
import { NoteEditor } from "../components/NoteEditor";
import { ExamenBlanc } from "../components/ExamenBlanc";
import { ExportPdf } from "../components/ExportPdf";
import { TelechargerHorsLigne } from "../components/TelechargerHorsLigne";
import { TailleTexte, useTailleTexte } from "../components/TailleTexte";
import { SelectionBar } from "../components/SelectionBar";
import { SignalementModal } from "../components/SignalementModal";
import { ViewerSkeleton } from "../components/Skeleton";
import { Watermark } from "../components/Watermark";
import { extractSourceMarkdownForSelection } from "../lib/markdownSource";
import { locale, t } from "../i18n";

type Onglet = "sujet" | "corrige";

function useIsMobile(breakpoint = 640): boolean {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    function onResize() {
      setIsMobile(window.innerWidth < breakpoint);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}

/** Carte « accès refusé » avec les deux sorties possibles : connexion (le
 * visiteur sur une épreuve payante — 401) ou abonnement (connecté non
 * couvert — 403). CTA distincts selon le statut. */
function Paywall({ necessiteConnexion }: { necessiteConnexion: boolean }) {
  return (
    <div className="mx-auto mt-10 max-w-md rounded-lg border border-ink-soft/15 bg-paper-raised p-6 text-center">
      <Lock size={28} strokeWidth={1.5} aria-hidden="true" className="mx-auto text-highlight-text" />
      <h1 className="mt-3 font-serif-brand text-xl">
        {necessiteConnexion ? t("Cette épreuve est réservée aux comptes") : t("Accès non autorisé à cette épreuve")}
      </h1>
      <p className="mt-2 text-sm text-ink-soft">
        {necessiteConnexion
          ? t("Connecte-toi pour la consulter, ou découvre les abonnements qui ouvrent tout le catalogue.")
          : t("Un abonnement couvrant cette filière/matière/année est requis.")}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Link
          to="/connexion"
          className="min-h-[44px] rounded-full bg-ink px-5 text-sm font-medium leading-[44px] text-paper hover:opacity-90"
        >
          {t("Se connecter")}
        </Link>
        <Link
          to="/abonnement"
          className="min-h-[44px] rounded-full border border-ink-soft/25 px-5 text-sm font-medium leading-[44px] text-ink-soft hover:border-highlight/50 hover:bg-highlight-soft/40"
        >
          {t("Voir les abonnements")}
        </Link>
      </div>
    </div>
  );
}

export function ViewerPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [taille, changerTaille] = useTailleTexte();
  // Examen blanc en cours : corrigé et assistant masqués.
  const [examenEnCours, setExamenEnCours] = useState(false);
  const [searchParams] = useSearchParams();
  // Deep-link depuis le profil : /epreuve/{id}?conv={id} rouvre l'onglet de
  // discussion exact de l'historique d'activité.
  const convOuverte = searchParams.get("conv");
  const [epreuve, setEpreuve] = useState<EpreuveDetail | null>(null);
  const [erreurAcces, setErreurAcces] = useState(false);
  const [necessiteConnexion, setNecessiteConnexion] = useState(false);
  const [erreurChargement, setErreurChargement] = useState(false);
  const [onglet, setOnglet] = useState<Onglet>("sujet");
  // Sujet affiché : la rangée d'onglets (Sujet 1, Sujet 2…) passe de l'un à
  // l'autre — l'index 0 est le sujet principal. `epreuve.sujets` est la
  // source de vérité (les champs à plat restent rétrocompatibles).
  const [sujetActif, setSujetActif] = useState(0);
  const [selection, setSelection] = useState<{ x: number; y: number; markdown: string } | null>(
    null
  );
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [pendingContext, setPendingContext] = useState<string | null>(null);
  const [pasteSignal, setPasteSignal] = useState<PasteSignal | null>(null);
  // Note en cours de saisie : contexte prérempli (passage sélectionné ou
  // réponse de l'assistant « Sauvegarder en note »), contenu null = création.
  const [noteOuverte, setNoteOuverte] = useState<{ contexte: string; contenu?: string } | null>(
    null
  );
  const [signalementOuvert, setSignalementOuvert] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const mobile = useIsMobile();

  // Sujet en cours d'affichage : procure les bonnes zones sujet/corrigé.
  // Repli sur l'index 0 à plat pour les épreuves antérieures au chantier
  // multi-sujets (pas de tableau `sujets` renvoyé par l'API). Mémoïsé pour
  // une identité stable entre rendus (dépendances des callbacks ci-dessous).
  const sujetActifData = useMemo(
    () =>
      epreuve
        ? epreuve.sujets && epreuve.sujets.length > 0
          ? (epreuve.sujets.find((s) => s.index === sujetActif) ?? epreuve.sujets[0])
          : {
              index: 0,
              contenu_markdown: epreuve.contenu_markdown ?? "",
              corrige_markdown: epreuve.corrige_markdown ?? "",
              corrige_disponible: epreuve.corrige_disponible,
            }
        : null,
    [epreuve, sujetActif]
  );

  useEffect(() => {
    if (!id) return;
    // Reset complet au changement d'épreuve : sans lui, l'épreuve
    // précédente restait affichée (filigrane et fiche compris) pendant
    // tout le chargement de la suivante, et une réponse réseau arrivant
    // après une navigation plus récente écrasait la bonne épreuve.
    setEpreuve(null);
    setErreurAcces(false);
    setNecessiteConnexion(false);
    setErreurChargement(false);
    setOnglet("sujet");
    setSujetActif(0);
    const ac = new AbortController();
    api
      .get<EpreuveDetail>(`/api/epreuves/${id}`, undefined, ac.signal)
      .then((data) => {
        if (ac.signal.aborted) return;
        setEpreuve(data);
        // Deep-link ?conv= (lien « Reprendre la conversation » du profil) :
        // le panneau assistant s'ouvre — `ouvrirConversationId` cible la
        // discussion désignée. Sans cette ouverture, le lien ne faisait
        // qu'afficher l'épreuve (revue 2026-09, REVUE_FRONTEND.md F7).
        if (convOuverte) setAssistantOpen(true);
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        if (err instanceof ApiError && err.status === 403) setErreurAcces(true);
        else if (err instanceof ApiError && err.status === 401) setNecessiteConnexion(true);
        else setErreurChargement(true);
      });
    return () => ac.abort();
    // `user` dans les dépendances : déconnexion / ban / kick-out (user →
    // null) ou reconnexion pendant la lecture relancent le contrôle
    // d'accès — une épreuve payante redevient une carte paywall au lieu
    // de rester affichée à l'écran (revue 2026-09, REVUE_FRONTEND.md F6).
  }, [id, user, convOuverte]);

  // Garde-fou défensif : dès que le panneau se ferme (quelle que soit la
  // façon dont il a été fermé), on oublie tout contexte de sélection et
  // tout signal de collage en attente. Bug corrigé : sans ce reset, un
  // `pasteSignal` resté non-nul depuis une interaction précédente était
  // réappliqué à tort dès la prochaine ouverture du panneau (même sans
  // nouvelle sélection) — AssistantPanel a aussi son propre garde-fou
  // interne, ce reset côté parent est une seconde ligne de défense.
  useEffect(() => {
    if (!assistantOpen) {
      setPendingContext(null);
      setPasteSignal(null);
    }
  }, [assistantOpen]);

  // Déconnexion pendant la lecture (ban, kick-out) : on repart du squelette
  // en re-testant l'accès — une épreuve payante devient une carte de
  // connexion plutôt qu'un contenu encore affiché.
  useEffect(() => {
    setAssistantOpen(false);
    setNoteOuverte(null);
    setSelection(null);
  }, [user]);

  const updateFromSelection = useCallback(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!sel || !text || sel.rangeCount === 0 || !epreuve || sel.isCollapsed) {
      setSelection(null);
      return;
    }

    // Ne réagit qu'aux sélections PLEINEMENT contenues dans la zone
    // d'épreuve (pas à une sélection résiduelle passant par le panneau
    // assistant ou la barre elle-même).
    const node = sel.anchorNode;
    if (containerRef.current && node && !containerRef.current.contains(node)) {
      setSelection(null);
      return;
    }

    // On retrouve le Markdown BRUT (formules, tableaux, images compris)
    // correspondant à la sélection, plutôt que le texte affiché nettoyé —
    // c'est ce contenu brut qui est envoyé à l'assistant / à la note.
    const contenuActif =
      onglet === "sujet" ? sujetActifData?.contenu_markdown ?? "" : sujetActifData?.corrige_markdown ?? "";
    const markdown = extractSourceMarkdownForSelection(sel, contenuActif || "") ?? text;

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelection({ x: rect.left, y: rect.top - 48, markdown });
  }, [epreuve, onglet, sujetActifData]);

  // Sélection au TOUCHER (mobile) : `mouseup` ne se déclenche pas sur la
  // sélection par long-appui — on écoute le `selectionchange` global et on
  // relit la sélection une fois le pointage relâché (rAF). Le garde-fou
  // `containerRef.contains` ci-dessus ne retient que les sélections dans la
  // zone d'épreuve.
  useEffect(() => {
    if (!mobile) return;
    let raf = 0;
    function onSelectionChange() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(updateFromSelection);
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      cancelAnimationFrame(raf);
    };
  }, [mobile, updateFromSelection]);

  // La sélection par CLAVIER (Shift+flèches) ne déclenche aucun mouseup :
  // sans ce gestionnaire onKeyUp, les lecteurs au clavier ne pouvaient
  // jamais atteindre la barre « Demander / Prendre une note ».
  function onKeyUp() {
    updateFromSelection();
  }

  function onCopy(e: React.ClipboardEvent) {
    // La sélection reste pleinement active (nécessaire pour déclencher une
    // question à l'assistant) ; seule la copie vers le presse-papier
    // système est bloquée, ici, plutôt que via `user-select: none` qui
    // empêcherait la sélection elle-même (bug corrigé — voir index.css).
    e.preventDefault();
  }

  /**
   * Clic sur « Demander » de la barre de sélection :
   * - panneau FERMÉ → ouvre une nouvelle discussion avec ce passage comme
   *   contexte initial ;
   * - panneau OUVERT → colle le texte sélectionné dans le champ de saisie
   *   de la discussion EN COURS, SANS toucher à son contexte.
   */
  function askAbout(markdown: string) {
    if (assistantOpen) {
      setPasteSignal({ text: markdown, nonce: Date.now() });
    } else {
      setPendingContext(markdown);
      setAssistantOpen(true);
    }
    setSelection(null);
  }

  function openAssistantGeneral() {
    setPendingContext(null);
    setAssistantOpen(true);
  }

  // Raccourcis clavier du lecteur : S = sujet, C = corrigé, N = nouvelle
  // note — ignorés quand le focus est dans un champ de saisie, un élément
  // cliquable (bouton/lien), une zone éditable, ou dans une modale/dialog
  // (l'assistant, l'éditeur de note…) pour ne jamais intercepter une
  // frappe destinée à ces éléments. N est réservé aux comptes (le visiteur
  // n'a pas de notes).
  useEffect(() => {
    if (examenEnCours) {
      setOnglet("sujet");
      setAssistantOpen(false);
    }
  }, [examenEnCours]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!epreuve || examenEnCours) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A") return;
      if (el?.isContentEditable) return;
      if (el?.closest('[role="dialog"], [role="button"]')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "s" && sujetActifData?.contenu_markdown) setOnglet("sujet");
      else if (k === "c" && sujetActifData?.corrige_disponible) setOnglet("corrige");
      else if (k === "n" && user && user.consent_notes !== false) {
        e.preventDefault();
        setNoteOuverte({ contexte: "" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [epreuve, user, sujetActifData, examenEnCours]);

  function onTabsKeyDown(e: React.KeyboardEvent, current: Onglet) {
    const order: Onglet[] = ["sujet", "corrige"];
    const idx = order.indexOf(current);
    let next: Onglet | null = null;
    if (e.key === "ArrowRight") next = order[(idx + 1) % order.length];
    else if (e.key === "ArrowLeft") next = order[(idx - 1 + order.length) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (!next) return;
    e.preventDefault();
    setOnglet(next);
    (e.currentTarget as HTMLElement)
      .closest('[role="tablist"]')
      ?.querySelector<HTMLElement>(`#tab-${next}`)
      ?.focus();
  }

  /** Navigation clavier dans la rangée d'onglets des sujets (Sujet 1, Sujet
   * 2…) — ← / →, Home / End, focus déplacé avec la sélection. */
  function onSujetsKeyDown(e: React.KeyboardEvent, index: number) {
    const sujets = epreuve?.sujets ?? [];
    if (sujets.length === 0) return;
    const positions = sujets.map((s) => s.index);
    const pos = positions.indexOf(index);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = positions[(pos + 1) % positions.length];
    else if (e.key === "ArrowLeft") next = positions[(pos - 1 + positions.length) % positions.length];
    else if (e.key === "Home") next = positions[0];
    else if (e.key === "End") next = positions[positions.length - 1];
    if (next === null) return;
    e.preventDefault();
    setSujetActif(next);
    setOnglet("sujet");
    (e.currentTarget as HTMLElement)
      .closest('[role="tablist"]')
      ?.querySelector<HTMLElement>(`#sujet-tab-${next}`)
      ?.focus();
  }

  if (necessiteConnexion) {
    return <Paywall necessiteConnexion />;
  }

  if (erreurAcces) {
    return <Paywall necessiteConnexion={false} />;
  }

  if (erreurChargement) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-correction/30 bg-correction-soft p-6 text-correction"
      >
        Cette épreuve n'a pas pu être chargée (elle a peut-être été retirée).{" "}
        <button type="button" onClick={() => window.location.reload()} className="underline">
          {t("Réessayer")}
        </button>
      </div>
    );
  }

  if (!epreuve) return <ViewerSkeleton />;

  // Nombre de sujets de l'épreuve (1 par défaut — épreuves antérieures au
  // chantier multi-sujets sans tableau `sujets`).
  const nbSujets = epreuve.sujets && epreuve.sujets.length > 0 ? epreuve.sujets.length : 1;
  const contenuActif =
    onglet === "sujet" ? sujetActifData?.contenu_markdown ?? "" : sujetActifData?.corrige_markdown ?? "";

  // Props identiques pour les deux rendus (bureau/mobile) — seule la
  // variante `mobile` diffère.
  const panelProps = {
    epreuveId: epreuve.id,
    pendingContext,
    fullEpreuveContext: contenuActif || "",
    pasteSignal,
    ouvrirConversationId: convOuverte,
    onClose: () => setAssistantOpen(false),
    onSaveAsNote: (contenu: string, contexte: string) => setNoteOuverte({ contexte, contenu }),
  };

  return (
    <div className={`flex flex-col ${mobile ? "h-[calc(100dvh-6rem)]" : "h-[calc(100dvh-7rem)]"}`}>
      {/* Rangées d'en-tête FIXES (ne défilent pas) : tout l'espace vertical
          restant est réservé au panneau de lecture ci-dessous. */}
      <div className="shrink-0">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate font-serif-brand text-2xl">{epreuve.matiere}</h1>
            {/* Signalement : toujours VISIBLE (découvrabilité), en rouge
                « correction » ; désactivé en visiteur avec le motif du
                verrou — l'API exige de toute façon une session. */}
            <button
              type="button"
              onClick={() => user && setSignalementOuvert(true)}
              disabled={!user}
              title={user ? t("Signaler un problème sur cette épreuve") : t("Connecte-toi pour signaler un problème")}
              aria-label={t("Signaler un problème sur cette épreuve")}
              className={`p-1.5 text-correction ${user ? "hover:text-correction/75" : "cursor-not-allowed opacity-50"}`}
            >
              <Flag size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
          {/* Chronomètre + onglets sujet/corrigé : le chrono est proposé
              dès le chargement (activable/désactivable par l'élève), les
              onglets n'apparaissent que si un corrigé existe. */}
          {/* ExamenBlanc et Chronometre restent À LA MÊME PLACE dans l'arbre quel que
              soit l'état (sinon leur état se réinitialiserait au démarrage de
              l'examen) ; seuls l'export PDF et les onglets Sujet/Corrigé se
              masquent pendant l'examen. */}
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {user && <ExamenBlanc epreuveId={epreuve.id} duree={epreuve.duree} onChange={setExamenEnCours} />}
            {user && !examenEnCours && <TelechargerHorsLigne id={epreuve.id} matiere={epreuve.matiere} annee={epreuve.annee} evaluation={epreuve.evaluation} />}
            {!examenEnCours && (
              <ExportPdf
                titre={`${epreuve.matiere} — ${epreuve.evaluation} ${epreuve.annee}`}
                sujet={sujetActifData?.contenu_markdown ?? ""}
                corrige={sujetActifData?.corrige_markdown ?? ""}
                identite={`${user?.email ?? t("Consultation invitée")} · ${new Date().toLocaleDateString(locale())}`}
              />
            )}
            <Chronometre dureeEpreuve={epreuve.duree || null} />
              {sujetActifData?.corrige_disponible && !examenEnCours && (
            <div role="tablist" aria-label={t("Contenu de l'épreuve")} className="flex rounded-full border border-ink-soft/20 p-1">
                {([
                  ["sujet", "Sujet", FileText],
                  ["corrige", t("Corrigé"), ClipboardCheck],
                ] as [Onglet, string, typeof FileText][]).map(([o, label, Icon]) => (
                  <button
                    key={o}
                    role="tab"
                    id={`tab-${o}`}
                    aria-selected={onglet === o}
                    aria-controls="panel-epreuve"
                    tabIndex={onglet === o ? 0 : -1}
                    onClick={() => setOnglet(o)}
                    onKeyDown={(e) => onTabsKeyDown(e, o)}
                    title={`${label} (raccourci : ${o === "sujet" ? "S" : "C"})`}
                    className={`flex min-h-[44px] items-center gap-1.5 rounded-full px-4 py-1.5 text-sm ${
                      onglet === o ? "bg-ink text-paper" : "text-ink-soft"
                    }`}
                  >
                    <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Sujets multiples : rangée d'onglets pour choisir quel sujet
            afficher — le bascule revient toujours sur le sujet de l'onglet
            (jamais directement sur son corrigé). */}
        {nbSujets > 1 && (
          <div
            role="tablist"
            aria-label={t("Sujets de l'épreuve")}
            className="mb-3 flex flex-wrap items-center gap-1.5"
          >
            {(epreuve.sujets ?? []).map((s, i) => {
              const actif = s.index === sujetActifData?.index;
              return (
                <button
                  key={s.index}
                  type="button"
                  role="tab"
                  id={`sujet-tab-${s.index}`}
                  aria-selected={actif}
                  aria-controls="panel-epreuve"
                  tabIndex={actif ? 0 : -1}
                  onClick={() => {
                    setSujetActif(s.index);
                    setOnglet("sujet");
                  }}
                  onKeyDown={(e) => onSujetsKeyDown(e, s.index)}
                  title={t("Afficher le sujet {n}", { n: i + 1 })}
                  className={`flex min-h-[44px] items-center rounded-full px-4 py-1.5 text-sm transition-colors ${
                    actif ? "bg-ink text-paper" : "text-ink-soft hover:bg-highlight-soft/40"
                  }`}
                >
                  Sujet {i + 1}
                </button>
              );
            })}
          </div>
        )}

        {/* MOBILE : la méta + le bandeau visiteur se replient dans une ligne
            fine (élément <details>, replié par défaut) — zéro hauteur
            permanente ; on ne conserve que le strict minimum (titre + onglets,
            ci-dessus). L'épreuve gagne ainsi toute la place. */}
        {mobile ? (
          <details className="group mb-3 overflow-hidden rounded-lg border border-ink-soft/15 bg-paper-raised">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2">
              <ChevronRight
                size={13}
                strokeWidth={1.75}
                aria-hidden="true"
                className="shrink-0 text-slate transition-transform group-open:rotate-90"
              />
              <span className="truncate font-mono-tag text-[10px] uppercase tracking-wide text-ink-soft">
                {epreuve.evaluation} {epreuve.annee} · {t("SÉRIES")} {epreuve.filieres.join(",")}
              </span>
              {!user && (
                <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full border border-highlight/40 px-2 py-0.5 font-mono-tag text-[10px] text-ink-soft">
                  <Lock size={9} strokeWidth={2} aria-hidden="true" className="text-slate" />
                  {t("Visiteur")}
                </span>
              )}
            </summary>
            <div className="border-t border-ink-soft/15 px-4 py-3">
              <p className="font-mono-tag text-xs text-slate">
                {epreuve.evaluation} {epreuve.annee} · {epreuve.matiere.toUpperCase()} · {t("SÉRIES")}{" "}
                {epreuve.filieres.join(",")}
                {epreuve.duree ? ` · ${epreuve.duree}` : ""}
              </p>
              {!user && (
                <div className="mt-3 rounded-lg border border-highlight/40 bg-highlight-soft/40 px-4 py-3">
                  <p className="text-xs text-ink-soft">
                    Consultation libre en mode visiteur — les fonctionnalités du compte sont
                    visibles mais verrouillées :
                  </p>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {[
                      t("Tuteur IA Prep — poser des questions"),
                      "Notes personnelles",
                      t("Signaler un problème"),
                    ].map((libelle) => (
                      <li
                        key={libelle}
                        title={t("Connecte-toi pour utiliser cette fonctionnalité")}
                        className="flex min-h-[44px] cursor-not-allowed items-center gap-1.5 rounded-full border border-ink-soft/25 bg-paper-raised/60 px-3 text-xs text-ink-soft"
                      >
                        <Lock size={11} strokeWidth={2} aria-hidden="true" className="text-slate" />
                        {libelle}
                      </li>
                    ))}
                  </ul>
                  <Link
                    to="/connexion"
                    className="mt-2 inline-flex min-h-[44px] items-center rounded-full bg-ink px-4 text-xs font-medium text-paper hover:opacity-90"
                  >
                    {t("Se connecter pour tout débloquer")}
                  </Link>
                </div>
              )}
            </div>
          </details>
        ) : (
          <>
            <p className="font-mono-tag text-xs text-slate">
              {epreuve.evaluation} {epreuve.annee} · {epreuve.matiere.toUpperCase()} · {t("SÉRIES")}{" "}
              {epreuve.filieres.join(",")}
              {epreuve.duree ? ` · ${epreuve.duree}` : ""}
            </p>

            {/* Motif signature n°3 : double filet (letterhead), uniquement sur cette page */}
            <div className="my-3" aria-hidden="true">
              <div className="h-px bg-ink-soft/20" />
              <div className="h-[3px] bg-paper" />
              <div className="h-px bg-ink-soft/20" />
            </div>

            {!user && (
              <div className="rounded-lg border border-highlight/40 bg-highlight-soft/40 px-4 py-3">
                <p className="text-xs text-ink-soft">
                  Consultation libre en mode visiteur — les fonctionnalités du compte sont
                  visibles mais verrouillées :
                </p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {[
                    t("Tuteur IA Prep — poser des questions"),
                    "Notes personnelles",
                    t("Signaler un problème"),
                  ].map((libelle) => (
                    <li
                      key={libelle}
                      title={t("Connecte-toi pour utiliser cette fonctionnalité")}
                      className="flex min-h-[44px] cursor-not-allowed items-center gap-1.5 rounded-full border border-ink-soft/25 bg-paper-raised/60 px-3 text-xs text-ink-soft"
                    >
                      <Lock size={11} strokeWidth={2} aria-hidden="true" className="text-slate" />
                      {libelle}
                    </li>
                  ))}
                </ul>
                <Link
                  to="/connexion"
                  className="mt-2 inline-flex min-h-[44px] items-center rounded-full bg-ink px-4 text-xs font-medium text-paper hover:opacity-90"
                >
                  {t("Se connecter pour tout débloquer")}
                </Link>
              </div>
            )}
          </>
        )}
      </div>

      {/* Zone de lecture : height fixe, scroll INTERNE (le panneau ne défile
          plus avec la page). Le tiroir de l'assistant (bureau) est une
          colonne SŒUR du lecteur (même rangée flex, même hauteur) — jamais
          posé par-dessus : l'épreuve reste intégralement lisible. */}
      <div className="mt-3 flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          <div
            ref={containerRef}
            role="tabpanel"
            id="panel-epreuve"
            aria-labelledby={`tab-${onglet}`}
            onMouseUp={updateFromSelection}
            onKeyUp={onKeyUp}
            onCopy={onCopy}
            onContextMenu={(e) => e.preventDefault()}
            className="absolute inset-0 overflow-y-auto rounded-lg border border-ink-soft/15 bg-paper-raised p-6"
          >
            <Watermark label={`${user?.email ?? t("Consultation invitée")} · ${new Date().toLocaleString(locale())}`} />
            <div className="mb-2 flex justify-end print:hidden">
              <TailleTexte taille={taille} onChange={changerTaille} />
            </div>
            <div className="relative" style={{ zoom: taille }}>
              <MarkdownContent content={contenuActif || ""} variant="epreuve" trackSourcePositions />
            </div>
          </div>

          {/* Barre de sélection : TOUJOURS affichée (découvrabilité) — les
              actions compte y sont désactivées avec leur motif en info-bulle ;
              seul le lanceur flottant de l'assistant reste masqué au
              visiteur. */}
          {selection && (
            <SelectionBar
              x={selection.x}
              y={selection.y}
              peutDemander={user !== null && !examenEnCours}
              peutNoter={user !== null && user.consent_notes !== false}
              motifVerrou={
                user
                  ? t("Tu as refusé le stockage de tes notes — modifiable dans ton profil")
                  : t("Connecte-toi pour utiliser cette fonctionnalité")
              }
              onAsk={() => askAbout(selection.markdown)}
              onNote={() => {
                setNoteOuverte({ contexte: selection.markdown });
                setSelection(null);
              }}
            />
          )}

          {user && !assistantOpen && !examenEnCours && <AssistantLauncherButton onClick={openAssistantGeneral} />}
        </div>

        {/* Tiroir BUREAU : colonne latérale droite accolée au lecteur (pas de
            recouvrement de l'épreuve), même hauteur que lui, largeur fixe
            autour de 520-560. Fermeture : bouton X || Échap || bouton
            lanceur. */}
        {user && assistantOpen && !mobile && (
          <aside className="ml-4 min-h-0 w-[min(560px,46vw)] shrink-0 overflow-hidden rounded-lg border border-ink-soft/15 bg-paper-raised shadow-lg">
            <AssistantPanel {...panelProps} mobile={false} />
          </aside>
        )}
      </div>

      {/* Feuille MOBILE : plein écran sans rebord (le `top-16`/`rounded-t-lg`
          laissaient le panneau chevaucher l'en-tête et apparaître « en
          dessous »). */}
      {user && assistantOpen && mobile && <AssistantPanel {...panelProps} mobile />}

      {user && noteOuverte && (
        <NoteEditor
          epreuveId={epreuve.id}
          cible={onglet}
          contexteExtraitInitial={noteOuverte.contexte}
          contenuInitial={noteOuverte.contenu ?? ""}
          onClose={() => setNoteOuverte(null)}
        />
      )}

      {user && signalementOuvert && (
        <SignalementModal epreuveId={epreuve.id} onClose={() => setSignalementOuvert(false)} />
      )}
    </div>
  );
}
