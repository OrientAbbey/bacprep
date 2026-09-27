import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Seuls les VRAIS dialogues modaux sont arbitrés entre eux. Un simple
// `role="dialog"` ne suffit pas : `Chronometre` en porte un sans être
// bloquant et ne gère pas Échap — l'inclure ici ferait perdre Échap aux
// modales, le dernier du DOM n'étant plus nécessairement celui du dessus.
const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';

/** Présent à l'écran. `offsetParent` ne convient pas : il vaut `null` pour
 * un `position: fixed`, cas le plus fréquent des modales, qui serait donc
 * systématiquement considérée fermée. */
function estVisible(d: HTMLElement): boolean {
  if (!d.isConnected || d.hidden) return false;
  const style = window.getComputedStyle(d);
  return style.display !== "none" && style.visibility !== "hidden";
}

/** Modales actuellement à l'écran, dans l'ordre du DOM (= ordre d'empilement). */
function modalesVisibles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(DIALOG_SELECTOR)).filter(estVisible);
}

/**
 * La modale à qui revient Échap : `null` s'il n'y en a aucune.
 *
 * Un seul arbitrage pour TOUS les gestionateurs, sinon ils se contredisent :
 * deux modales empilées, le focus encore dans celle du dessous, et l'une
 * dit « c'est moi » pendant que l'autre dit « non, c'est moi » — Échap ne
 * ferme alors plus rien, silencieusement. Donc, dans l'ordre :
 * 1. la modale qui CONTIENT le focus : c'est celle que l'utilisateur
 *    manipule, y compris quand celle du dessus vient d'être montée et n'a
 *    pas encore pris le focus ;
 * 2. à défaut, la dernière du DOM, c'est-à-dire celle du dessus.
 */
function dialogueActif(): HTMLElement | null {
  const modales = modalesVisibles();
  if (modales.length === 0) return null;
  const actif = document.activeElement;
  if (actif instanceof Node) {
    const contenant = modales.find((d) => d.contains(actif));
    if (contenant) return contenant;
  }
  return modales[modales.length - 1];
}

/** Ce dialogue modal est-il celui qui doit recevoir Échap ? */
function estDialogueAuDessus(dialog: HTMLElement | null): boolean {
  if (!dialog) return false;
  return dialogueActif() === dialog;
}

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
  // `onClose` est le plus souvent une arrow function inline : nouvelle
  // identité à chaque rendu. Le lister en dépendance d'effet relançait donc
  // l'effet en boucle — le focus était restauré puis repris sur le premier
  // champ à chaque rendu, ce qui volait la saisie en cours (assistant en
  // streaming, chaque fragment SSE provoquant un rendu). Une ref miroir, plus
  // une liste de dépendances réduite à `open`, règlent les deux : le
  // gestionnaire lit toujours le `onClose` du dernier rendu sans jamais
  // réarmer le piège de focus.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

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
        // Un dialogue monté au-dessus (modale imbriquée) doit absorber
        // Échap ; sinon les deux se ferment ensemble.
        if (!estDialogueAuDessus(dialogRef.current)) return;
        e.preventDefault();
        onCloseRef.current();
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
  }, [open]);

  return dialogRef;
}