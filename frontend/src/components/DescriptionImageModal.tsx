import { Sparkles, Undo2 } from "lucide-react";
import { useState } from "react";
import { t } from "../i18n";
import { DESCRIPTION_MAX, nettoyerDescription } from "../lib/descriptionImage";
import { useModalFocus } from "../lib/useModalFocus";
import { Spinner } from "./Spinner";

/** Décrire une image (texte alternatif) : à la main, ou en partant d'une
 * proposition de l'IA. L'IA ne fait que REMPLIR la zone de texte ; rien n'est
 * appliqué au Markdown avant « Appliquer au texte », et l'épreuve n'est
 * enregistrée qu'avec son bouton habituel. */
export function DescriptionImageModal({
  imageUrl,
  initial,
  onProposer,
  onAppliquer,
  onClose,
}: {
  imageUrl: string;
  initial: string;
  /** Demande une proposition à l'IA (rejette si elle est indisponible : la saisie manuelle reste possible). */
  onProposer: () => Promise<string>;
  onAppliquer: (description: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useModalFocus<HTMLDivElement>({ open: true, onClose });
  const [texte, setTexte] = useState(initial);
  const [avant, setAvant] = useState<string | null>(null); // texte saisi avant la proposition de l'IA, pour pouvoir le rétablir
  const [enCours, setEnCours] = useState(false);
  const [echec, setEchec] = useState(false);
  const [proposee, setProposee] = useState(false); // le texte affiché vient de l'IA : à relire

  async function proposer() {
    setEnCours(true);
    setEchec(false);
    try {
      const proposition = await onProposer();
      setAvant(texte.trim() ? texte : null);
      setTexte(proposition);
      setProposee(true);
    } catch {
      setEchec(true);
    } finally {
      setEnCours(false);
    }
  }

  const bouton = "flex min-h-[44px] items-center gap-2 rounded-full px-4 text-sm font-medium disabled:opacity-60";
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("Décrire l'image")}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-ink-soft/15 bg-paper-raised p-5 shadow-xl"
      >
        <h2 className="font-serif-brand text-lg">{t("Décrire l'image")}</h2>
        <img src={imageUrl} alt="" className="mx-auto mt-3 max-h-40 rounded border border-ink-soft/15 bg-paper object-contain" />
        <p className="mt-3 text-sm text-ink-soft">
          {t("Décris ce que montre cette image, pour quelqu'un qui ne la voit pas. L'IA peut proposer un texte : relis-le avant d'appliquer.")}
        </p>

        <label htmlFor="desc-image-texte" className="mt-3 block font-mono-tag text-[10px] text-ink-soft">
          {t("Texte alternatif")}
        </label>
        <textarea
          id="desc-image-texte"
          value={texte}
          onChange={(e) => {
            setTexte(e.target.value);
          }}
          maxLength={DESCRIPTION_MAX}
          rows={5}
          className="mt-1 w-full rounded-[2px] border border-ink-soft/25 bg-paper p-3 text-sm"
        />
        <div className="flex items-center justify-between font-mono-tag text-[10px] text-slate">
          <span>{t("{n} / {max} caractères", { n: texte.length, max: DESCRIPTION_MAX })}</span>
          {avant !== null && (
            <button
              type="button"
              onClick={() => {
                setTexte(avant);
                setAvant(null);
                setProposee(false);
              }}
              className="flex items-center gap-1 underline"
            >
              <Undo2 size={12} strokeWidth={1.75} aria-hidden="true" />
              {t("Rétablir mon texte")}
            </button>
          )}
        </div>
        <p role="status" aria-live="polite" className={`mt-1 min-h-[1.25rem] text-xs ${echec ? "text-correction" : "text-ink-soft"}`}>
          {echec
            ? t("L'IA n'a pas pu proposer de description — écris-la à la main.")
            : proposee
              ? t("Relis la proposition de l'IA avant d'appliquer.")
              : ""}
        </p>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => void proposer()}
            disabled={enCours}
            className={`${bouton} border border-ink-soft/25 hover:bg-highlight-soft`}
          >
            {enCours ? <Spinner /> : <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />}
            {t("Proposer avec l'IA")}
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={`${bouton} border border-ink-soft/25 hover:bg-highlight-soft`}>
              {t("Annuler")}
            </button>
            <button
              type="button"
              onClick={() => onAppliquer(nettoyerDescription(texte))}
              disabled={!nettoyerDescription(texte)}
              className={`${bouton} bg-ink text-paper hover:opacity-90`}
            >
              {t("Appliquer au texte")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
