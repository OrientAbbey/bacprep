import type { RefObject } from "react";
import { GROUPES_OUTILS, type OutilFormule } from "../lib/renduMath";

/**
 * Barre d'insertion de formules, partagée par l'éditeur d'épreuves et celui de
 * la banque. Console admin : textes en français (convention du back-office).
 *
 * L'insertion se fait à la position du curseur dans le `<textarea>` contrôlé,
 * puis la portion à remplacer est sélectionnée (modèle `§…§` dans renduMath).
 * Tout est accessible au clavier : chaque outil est un vrai `<button>`.
 */
export function FormulesToolbar({
  textareaRef,
  onChanger,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Nouvelle valeur du textarea (le parent est contrôlé par son état). */
  onChanger: (valeur: string) => void;
}) {
  function inserer(outil: OutilFormule) {
    const zone = textareaRef.current;
    if (!zone) return;
    const debut = zone.selectionStart;
    const fin = zone.selectionEnd;
    const nouvelleValeur = zone.value.slice(0, debut) + outil.extrait + zone.value.slice(fin);
    onChanger(nouvelleValeur);
    // Le DOM est contrôlé : on attend le rendu de React avant de replacer le curseur.
    requestAnimationFrame(() => {
      zone.focus();
      zone.setSelectionRange(debut + outil.debut, debut + outil.fin);
    });
  }

  return (
    <div className="flex flex-wrap gap-1.5 rounded border border-ink-soft/15 bg-paper-raised p-2" aria-label="Outils d'insertion de formules">
      {GROUPES_OUTILS.map((groupe) => (
        <details key={groupe.nom} className="group relative">
          <summary className="cursor-pointer list-none rounded-full border border-ink-soft/25 px-3 py-1 text-xs font-medium hover:bg-highlight-soft">
            {groupe.nom}
          </summary>
          <div role="group" aria-label={`Outils ${groupe.nom}`} className="flex flex-wrap gap-1 pt-2">
            {groupe.outils.map((outil) => (
              <button
                key={outil.titre}
                type="button"
                title={outil.titre}
                aria-label={`Insérer : ${outil.titre}`}
                onClick={() => inserer(outil)}
                className="min-h-[36px] min-w-[36px] rounded border border-ink-soft/20 bg-paper px-2 font-mono text-xs hover:border-highlight hover:bg-highlight-soft"
              >
                {outil.libelle}
              </button>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
