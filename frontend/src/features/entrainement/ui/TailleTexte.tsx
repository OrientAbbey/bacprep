import { useEffect, useRef, useState, type RefObject } from "react";
import { borner, memoriserZoom, palierVoisin, zoomInitial, zoomPince } from "../lib/zoomLecteur";

/** Zoom de la feuille du lecteur (mémorisé sur l'appareil) : `changer` passe au palier voisin (A−/A+), `pincer`
 * applique un zoom continu pendant un pincement, `memoriser` l'enregistre à la fin du geste. `zoom` est appliqué au
 * conteneur de la feuille par l'appelant. */
export function useTailleTexte() {
  const [taille, setTaille] = useState(zoomInitial);
  const changer = (delta: -1 | 1) => {
    const n = palierVoisin(taille, delta);
    setTaille(n);
    memoriserZoom(n);
  };
  const regler = (zoom: number) => {
    const n = borner(zoom);
    setTaille(n);
    memoriserZoom(n);
  };
  return { taille, changer, regler, pincer: setTaille, memoriser: () => memoriserZoom(taille) };
}

/** Pincement à deux doigts SUR `ref` : zoome la feuille et non la page. `touch-action: pan-x pan-y` (classes de
 * l'élément) retire au navigateur le zoom de page à cet endroit ; les évènements `gesture*` couvrent Safari iOS.
 * `actif` relance l'écoute quand l'élément apparaît (le lecteur n'est monté qu'une fois l'épreuve chargée). */
export function usePincementZoom(ref: RefObject<HTMLElement | null>, actif: boolean, taille: number, pincer: (z: number) => void, fin: () => void) {
  const courant = useRef({ taille, pincer, fin });
  courant.current = { taille, pincer, fin };
  useEffect(() => {
    const el = ref.current;
    if (!el || !actif) return;
    let depart: { ecart: number; zoom: number } | null = null;
    const ecart = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const debut = (e: TouchEvent) => {
      if (e.touches.length === 2) depart = { ecart: ecart(e), zoom: courant.current.taille };
    };
    const bouge = (e: TouchEvent) => {
      if (!depart || e.touches.length !== 2) return;
      e.preventDefault();
      courant.current.pincer(zoomPince(depart.zoom, depart.ecart, ecart(e)));
    };
    const termine = (e: TouchEvent) => {
      if (depart && e.touches.length < 2) {
        depart = null;
        courant.current.fin();
      }
    };
    const bloquer = (e: Event) => e.preventDefault();
    el.addEventListener("touchstart", debut, { passive: true });
    el.addEventListener("touchmove", bouge, { passive: false });
    el.addEventListener("touchend", termine);
    el.addEventListener("touchcancel", termine);
    el.addEventListener("gesturestart", bloquer);
    el.addEventListener("gesturechange", bloquer);
    return () => {
      el.removeEventListener("touchstart", debut);
      el.removeEventListener("touchmove", bouge);
      el.removeEventListener("touchend", termine);
      el.removeEventListener("touchcancel", termine);
      el.removeEventListener("gesturestart", bloquer);
      el.removeEventListener("gesturechange", bloquer);
    };
  }, [ref, actif]);
}
