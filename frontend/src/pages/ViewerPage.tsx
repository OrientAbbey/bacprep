import { ClipboardCheck, FileText, Flag, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { EpreuveDetail } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { AssistantLauncherButton } from "../components/AssistantLauncherButton";
import { AssistantPanel, PasteSignal } from "../components/AssistantPanel";
import { MarkdownContent } from "../components/MarkdownContent";
import { NoteEditor } from "../components/NoteEditor";
import { SelectionBar } from "../components/SelectionBar";
import { SignalementModal } from "../components/SignalementModal";
import { ViewerSkeleton } from "../components/Skeleton";
import { Watermark } from "../components/Watermark";
import { extractSourceMarkdownForSelection } from "../lib/markdownSource";

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
      <Lock size={28} strokeWidth={1.5} aria-hidden="true" className="mx-auto text-highlight" />
      <h1 className="mt-3 font-serif-brand text-xl">
        {necessiteConnexion ? "Cette épreuve est réservée aux comptes" : "Accès non autorisé à cette épreuve"}
      </h1>
      <p className="mt-2 text-sm text-ink-soft">
        {necessiteConnexion
          ? "Connecte-toi pour la consulter, ou découvre les abonnements qui ouvrent tout le catalogue."
          : "Un abonnement couvrant cette filière/matière/année est requis."}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Link
          to="/connexion"
          className="min-h-[44px] rounded-full bg-ink px-5 text-sm font-medium leading-[44px] text-paper hover:opacity-90"
        >
          Se connecter
        </Link>
        <Link
          to="/abonnement"
          className="min-h-[44px] rounded-full border border-ink-soft/25 px-5 text-sm font-medium leading-[44px] text-ink-soft hover:border-highlight/50 hover:bg-highlight-soft/40"
        >
          Voir les abonnements
        </Link>
      </div>
    </div>
  );
}

export function ViewerPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  // Deep-link depuis le profil : /epreuve/{id}?conv={id} rouvre l'onglet de
  // discussion exact de l'historique d'activité.
  const convOuverte = searchParams.get("conv");
  const [epreuve, setEpreuve] = useState<EpreuveDetail | null>(null);
  const [erreurAcces, setErreurAcces] = useState(false);
  const [necessiteConnexion, setNecessiteConnexion] = useState(false);
  const [erreurChargement, setErreurChargement] = useState(false);
  const [onglet, setOnglet] = useState<Onglet>("sujet");
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
    const ac = new AbortController();
    api
      .get<EpreuveDetail>(`/api/epreuves/${id}`, undefined, ac.signal)
      .then((data) => {
        if (!ac.signal.aborted) setEpreuve(data);
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        if (err instanceof ApiError && err.status === 403) setErreurAcces(true);
        else if (err instanceof ApiError && err.status === 401) setNecessiteConnexion(true);
        else setErreurChargement(true);
      });
    return () => ac.abort();
  }, [id]);

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

  function onMouseUp() {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!sel || !text || sel.rangeCount === 0 || !epreuve) {
      setSelection(null);
      return;
    }

    // On retrouve le Markdown BRUT (formules, tableaux, images compris)
    // correspondant à la sélection, plutôt que le texte affiché nettoyé —
    // c'est ce contenu brut qui est envoyé à l'assistant / à la note.
    const contenuActif = onglet === "sujet" ? epreuve.contenu_markdown : epreuve.corrige_markdown;
    const markdown = extractSourceMarkdownForSelection(sel, contenuActif || "") ?? text;

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelection({ x: rect.left, y: rect.top - 48, markdown });
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
  // note — ignorés quand le focus est dans un champ de saisie. N est
  // réservé aux comptes (le visiteur n'a pas de notes).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!epreuve) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "s" && epreuve.contenu_markdown) setOnglet("sujet");
      else if (k === "c" && epreuve.corrige_disponible) setOnglet("corrige");
      else if (k === "n" && user && user.consent_notes !== false) {
        e.preventDefault();
        setNoteOuverte({ contexte: "" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [epreuve, user]);

  if (necessiteConnexion) {
    return <Paywall necessiteConnexion />;
  }

  if (erreurAcces) {
    return <Paywall necessiteConnexion={false} />;
  }

  if (erreurChargement) {
    return (
      <div className="rounded-lg border border-correction/30 bg-correction-soft p-6 text-correction">
        Cette épreuve n'a pas pu être chargée (elle a peut-être été retirée).{" "}
        <button type="button" onClick={() => window.location.reload()} className="underline">
          Réessayer
        </button>
      </div>
    );
  }

  if (!epreuve) return <ViewerSkeleton />;

  const contenuActif = onglet === "sujet" ? epreuve.contenu_markdown : epreuve.corrige_markdown;
  const showSideBySide = assistantOpen && !mobile;

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
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="font-serif-brand text-2xl">{epreuve.matiere}</h1>
            {/* Signalement : toujours VISIBLE (découvrabilité), en rouge
                « correction » ; désactivé en visiteur avec le motif du
                verrou — l'API exige de toute façon une session. */}
            <button
              type="button"
              onClick={() => user && setSignalementOuvert(true)}
              disabled={!user}
              title={user ? "Signaler un problème sur cette épreuve" : "Connecte-toi pour signaler un problème"}
              aria-label="Signaler un problème sur cette épreuve"
              className={`p-1.5 text-correction ${user ? "hover:text-correction/75" : "cursor-not-allowed opacity-50"}`}
            >
              <Flag size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
          {epreuve.corrige_disponible && (
            <div className="flex rounded-full border border-ink-soft/20 p-1">
              {([
                ["sujet", "Sujet", FileText],
                ["corrige", "Corrigé", ClipboardCheck],
              ] as [Onglet, string, typeof FileText][]).map(([o, label, Icon]) => (
                <button
                  key={o}
                  onClick={() => setOnglet(o)}
                  title={`${label} (raccourci : ${o === "sujet" ? "S" : "C"})`}
                  className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm ${
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

        <p className="font-mono-tag text-xs text-slate">
          {epreuve.evaluation} {epreuve.annee} · {epreuve.matiere.toUpperCase()} · SÉRIES{" "}
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
          <div className="mb-3 rounded-lg border border-highlight/40 bg-highlight-soft/40 px-4 py-3">
            <p className="text-xs text-ink-soft">
              Consultation libre en mode visiteur — les fonctionnalités du compte sont
              visibles mais verrouillées :
            </p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {[
                "Tuteur IA Prep — poser des questions",
                "Notes personnelles",
                "Signaler un problème",
              ].map((libelle) => (
                <li
                  key={libelle}
                  title="Connecte-toi pour utiliser cette fonctionnalité"
                  className="flex cursor-not-allowed items-center gap-1.5 rounded-full border border-ink-soft/25 bg-paper-raised/60 px-3 py-1.5 text-xs text-ink-soft"
                >
                  <Lock size={11} strokeWidth={2} aria-hidden="true" className="text-slate" />
                  {libelle}
                </li>
              ))}
            </ul>
            <Link
              to="/connexion"
              className="mt-2 inline-flex min-h-[36px] items-center rounded-full bg-ink px-4 text-xs font-medium text-paper hover:opacity-90"
            >
              Se connecter pour tout débloquer
            </Link>
          </div>
        )}

        <div
          ref={containerRef}
          onMouseUp={onMouseUp}
          onCopy={onCopy}
          className="relative overflow-hidden rounded-lg border border-ink-soft/15 bg-paper-raised p-6"
        >
          <Watermark label={`${user?.email ?? "Consultation invitée"} · ${new Date().toLocaleString("fr-FR")}`} />
          <div className="relative">
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
            peutDemander={user !== null}
            peutNoter={user !== null && user.consent_notes !== false}
            motifVerrou={
              user
                ? "Tu as refusé le stockage de tes notes — modifiable dans ton profil"
                : "Connecte-toi pour utiliser cette fonctionnalité"
            }
            onAsk={() => askAbout(selection.markdown)}
            onNote={() => {
              setNoteOuverte({ contexte: selection.markdown });
              setSelection(null);
            }}
          />
        )}

        {user && !assistantOpen && <AssistantLauncherButton onClick={openAssistantGeneral} />}
      </div>

      {/* Bureau : panneau affiché À CÔTÉ du contenu (colonne latérale qui
          réduit la largeur de la zone de lecture), jamais par-dessus, et
          toujours au-dessus de l'en-tête (z-40 > z-30 du header) plutôt
          que de risquer de passer derrière lui. Mobile : feuille modale
          plein écran depuis le bas (voir AssistantPanel). */}
      {user &&
        assistantOpen &&
        (mobile ? (
          <AssistantPanel {...panelProps} mobile />
        ) : (
          <aside className="sticky top-20 z-40 h-[calc(100vh-6rem)] w-[380px] shrink-0 overflow-hidden rounded-lg border border-ink-soft/15 shadow-lg">
            <AssistantPanel {...panelProps} mobile={false} />
          </aside>
        ))}

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
