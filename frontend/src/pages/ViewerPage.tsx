import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { EpreuveDetail } from "../api/types";
import { AssistantLauncherButton } from "../components/AssistantLauncherButton";
import { AssistantPanel, PasteSignal } from "../components/AssistantPanel";
import { FloatingAskButton } from "../components/FloatingAskButton";
import { MarkdownContent } from "../components/MarkdownContent";
import { Watermark } from "../components/Watermark";
import { useAuth } from "../auth/AuthProvider";
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

export function ViewerPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [epreuve, setEpreuve] = useState<EpreuveDetail | null>(null);
  const [erreurAcces, setErreurAcces] = useState(false);
  const [onglet, setOnglet] = useState<Onglet>("sujet");
  const [selection, setSelection] = useState<{ x: number; y: number; markdown: string } | null>(
    null
  );
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [pendingContext, setPendingContext] = useState<string | null>(null);
  const [pasteSignal, setPasteSignal] = useState<PasteSignal | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mobile = useIsMobile();

  useEffect(() => {
    if (!id) return;
    setErreurAcces(false);
    api
      .get<EpreuveDetail>(`/api/epreuves/${id}`)
      .then(setEpreuve)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) setErreurAcces(true);
      });
  }, [id]);

  // Garde-fou défensif : dès que le panneau se ferme (quelle que soit la
  // façon dont il a été fermé), on oublie tout contexte de sélection et
  // tout signal de collage en attente. Bug corrigé : sans ce reset, un
  // `pasteSignal` resté non-nul depuis une interaction précédente était
  // réappliqué à tort dès la prochaine ouverture du panneau (même sans
  // nouvelle sélection) — AssistantPanel a aussi son propre garde-fou
  // interne (référence initialisée avec le nonce déjà présent au montage),
  // ce reset côté parent est une seconde ligne de défense.
  useEffect(() => {
    if (!assistantOpen) {
      setPendingContext(null);
      setPasteSignal(null);
    }
  }, [assistantOpen]);

  function onMouseUp() {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!sel || !text || sel.rangeCount === 0 || !epreuve) {
      setSelection(null);
      return;
    }

    // On retrouve le Markdown BRUT (formules, tableaux, images compris)
    // correspondant à la sélection, plutôt que le texte affiché nettoyé —
    // c'est ce contenu brut qui sera envoyé à l'assistant comme contexte.
    // À défaut (sélection sans ancêtre traçable), on retombe sur le texte
    // brut sélectionné.
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
   * Réagit à un clic sur le bouton flottant de sélection :
   * - panneau FERMÉ → ouvre une nouvelle discussion avec ce passage comme
   *   contexte initial (comportement inchangé, bouton "Demander à
   *   l'assistant") ;
   * - panneau OUVERT → colle le texte sélectionné dans le champ de saisie
   *   de la discussion EN COURS (bouton "Copier dans le chat"), SANS
   *   toucher au contexte déjà associé à cette discussion (bug corrigé :
   *   une version précédente remplaçait le contexte en cours, ce qui
   *   n'est pas le comportement voulu).
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

  if (erreurAcces) {
    return (
      <div className="rounded-lg border border-correction/30 bg-correction-soft p-6 text-correction">
        Accès non autorisé à cette épreuve. Un abonnement couvrant cette filière/matière/année est requis.
      </div>
    );
  }

  if (!epreuve) return <p className="text-sm text-slate">Chargement…</p>;

  const contenuActif = onglet === "sujet" ? epreuve.contenu_markdown : epreuve.corrige_markdown;
  const showSideBySide = assistantOpen && !mobile;

  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h1 className="font-serif-brand text-2xl">{epreuve.matiere}</h1>
          </div>
          {epreuve.corrige_disponible && (
            <div className="flex rounded-full border border-ink-soft/20 p-1">
              {(["sujet", "corrige"] as Onglet[]).map((o) => (
                <button
                  key={o}
                  onClick={() => setOnglet(o)}
                  className={`rounded-full px-4 py-1.5 text-sm ${
                    onglet === o ? "bg-ink text-paper" : "text-ink-soft"
                  }`}
                >
                  {o === "sujet" ? "Sujet" : "Corrigé"}
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

        <div
          ref={containerRef}
          onMouseUp={onMouseUp}
          onCopy={onCopy}
          className="relative overflow-hidden rounded-lg border border-ink-soft/15 bg-paper-raised p-6"
        >
          <Watermark label={`${user?.email ?? ""} · ${new Date().toLocaleString("fr-FR")}`} />
          <div className="relative">
            <MarkdownContent content={contenuActif || ""} variant="epreuve" trackSourcePositions />
          </div>
        </div>

        {selection && (
          <FloatingAskButton
            x={selection.x}
            y={selection.y}
            onClick={() => askAbout(selection.markdown)}
            label={assistantOpen ? "Copier dans le chat" : "Demander à l'assistant"}
          />
        )}

        {!assistantOpen && <AssistantLauncherButton onClick={openAssistantGeneral} />}
      </div>

      {/* Bureau : panneau affiché À CÔTÉ du contenu (colonne latérale qui
          réduit la largeur de la zone de lecture), jamais par-dessus, et
          toujours au-dessus de l'en-tête (z-40 > z-30 du header) plutôt
          que de risquer de passer derrière lui. Mobile : feuille modale
          plein écran depuis le bas (voir AssistantPanel). */}
      {showSideBySide && (
        <aside className="sticky top-20 z-40 h-[calc(100vh-6rem)] w-[380px] shrink-0 overflow-hidden rounded-lg border border-ink-soft/15 shadow-lg">
          <AssistantPanel
            epreuveId={epreuve.id}
            pendingContext={pendingContext}
            fullEpreuveContext={contenuActif || ""}
            pasteSignal={pasteSignal}
            onClose={() => setAssistantOpen(false)}
            mobile={false}
          />
        </aside>
      )}
      {assistantOpen && mobile && (
        <AssistantPanel
          epreuveId={epreuve.id}
          pendingContext={pendingContext}
          fullEpreuveContext={contenuActif || ""}
          pasteSignal={pasteSignal}
          onClose={() => setAssistantOpen(false)}
          mobile
        />
      )}
    </div>
  );
}
