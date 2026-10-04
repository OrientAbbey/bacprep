import { Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MarkdownContent } from "./MarkdownContent";

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

  useEffect(() => {
    if (!choix) return;
    const fin = () => setChoix(null);
    window.addEventListener("afterprint", fin, { once: true });
    // Laisse React rendre la zone d'impression (et KaTeX/images) avant d'ouvrir la boîte d'impression.
    const t = window.setTimeout(() => window.print(), 600);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("afterprint", fin);
    };
  }, [choix]);

  const options: [ChoixPdf, string][] = [["sujet", "Sujet"], ...(corrige ? ([["corrige", "Corrigé"], ["les-deux", "Sujet et corrigé"]] as [ChoixPdf, string][]) : [])];

  return (
    <>
      <div className="relative">
        <button
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
          <div className="print-zone">
            <h1>{titre}</h1>
            {(choix === "sujet" || choix === "les-deux") && <MarkdownContent content={sujet} variant="epreuve" />}
            {choix === "les-deux" && <hr />}
            {(choix === "corrige" || choix === "les-deux") && (
              <>
                <h2>Corrigé</h2>
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
