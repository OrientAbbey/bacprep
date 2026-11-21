import { Printer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MarkdownContent } from "./MarkdownContent";
import { prechargerMol } from "./MolBlock";
import { t } from "../../i18n";

/** Cible d'une impressions PDF : sujet, corrigé ou les deux à la fois. */
export type ChoixPdf = "sujet" | "corrige" | "les-deux";

/**
 * Export PDF d'un sujet : la zone d'impression (portail hors de #root) n'est
 * visible qu'à l'impression (voir index.css, @media print) ; le navigateur
 * propose « Enregistrer au format PDF ». Seul le contenu déjà affiché à
 * l'élève (donc déjà accessible à son compte) est imprimé.
 */
export function ExportPdf({
  titre,
  sujet,
  corrige,
  identite,
}: {
  titre: string;
  sujet: string;
  corrige: string;
  identite: string;
}) {
  const [choix, setChoix] = useState<ChoixPdf | null>(null);
  const [menu, setMenu] = useState(false);
  const boiteRef = useRef<HTMLDivElement>(null);
  const boutonRef = useRef<HTMLButtonElement>(null);

  // Le menu de choix (Sujet / Corrigé / Les deux) se referme comme un vrai
  // menu : clic à côté, ou Échap (le focus revient alors au bouton PDF).
  // Sans cela, cliquer ailleurs le laissait ouvert au-dessus du lecteur.
  useEffect(() => {
    if (!menu) return;
    const dehors = (e: PointerEvent) => {
      if (!boiteRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const echap = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(false);
      boutonRef.current?.focus();
    };
    document.addEventListener("pointerdown", dehors);
    document.addEventListener("keydown", echap);
    return () => {
      document.removeEventListener("pointerdown", dehors);
      document.removeEventListener("keydown", echap);
    };
  }, [menu]);

  useEffect(() => {
    if (!choix) return;
    let annule = false;
    let minuteur: number | undefined;
    const fin = () => setChoix(null);
    window.addEventListener("afterprint", fin, { once: true });
    // Laisse React rendre la zone d'impression (et KaTeX/images), et attend le
    // chunk SmilesDrawer, avant d'ouvrir la boîte d'impression.
    void prechargerMol()
      .catch(() => undefined)
      .finally(() => {
        if (!annule) minuteur = window.setTimeout(() => window.print(), 600);
      });
    return () => {
      annule = true;
      if (minuteur !== undefined) window.clearTimeout(minuteur);
      window.removeEventListener("afterprint", fin);
    };
  }, [choix]);

  const options: [ChoixPdf, string][] = [["sujet", t("Sujet")], ...(corrige ? ([["corrige", t("Corrigé")], ["les-deux", t("Sujet et corrigé")]] as [ChoixPdf, string][]) : [])];

  return (
    <>
      <div className="relative" ref={boiteRef}>
        <button
          ref={boutonRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
          className="flex min-h-[44px] items-center gap-1.5 rounded-full border border-ink-soft/25 px-3 text-sm"
        >
          <Printer size={14} aria-hidden="true" /> PDF
        </button>
        {menu && (
          <div role="menu" className="absolute right-0 z-20 mt-1 min-w-[170px] rounded-lg border border-ink-soft/20 bg-paper-raised p-1 shadow-lg">
            {options.map(([v, label]) => (
              <button
                key={v}
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setChoix(v);
                }}
                className="block min-h-[44px] w-full rounded px-3 text-left text-sm hover:bg-highlight-soft"
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {choix &&
        createPortal(
          <div className="print-zone print-zone--actif">
            <h1>{titre}</h1>
            {(choix === "sujet" || choix === "les-deux") && <MarkdownContent content={sujet} variant="epreuve" />}
            {choix === "les-deux" && <hr />}
            {(choix === "corrige" || choix === "les-deux") && (
              <>
                <h2>{t("Corrigé")}</h2>
                <MarkdownContent content={corrige} variant="epreuve" />
              </>
            )}
            <p className="print-pied">{identite}</p>
          </div>,
          document.body
        )}
    </>
  );
}
