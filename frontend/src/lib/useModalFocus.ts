import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessibilité des modales (dialogue bloquant) :
 * - mémorise l'élément qui avait le focus AVANT l'ouverture ;
 * - au montage, déplace le focus sur le premier élément focusable (ou le
 *   dialogue lui-même s'il n'y en a aucun) ;
 * - piège la navigation Tab / Maj+Tab à l'intérieur du dialogue ;
 * - ferme sur Échap (extension naturelle de useEscapeKey, en une passe) ;
 * - à la fermeture, restaure le focus sur l'élément déclencheur.
 *
 * À brancher sur un composant rendu CONDITIONNELLEMENT (open ? null) :
 * `open` doit valoir true uniquement quand le dialogue est affiché, car
 * c'est le montage/démontage du composant qui délimite l'entrée/sortie.
 */
export function useModalFocus<T extends HTMLElement>({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<T | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;

    const dialog = dialogRef.current;
    if (dialog) {
      const premiersFocusables = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      (premiersFocusables[0] ?? dialog).focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (restoreRef.current) {
        restoreRef.current.focus();
      }
    };
  }, [open, onClose]);

  return dialogRef;
}