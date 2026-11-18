import { useEffect, useRef } from "react";
import {
  effacerContexteAdmin,
  enregistrerAppliqueurAdmin,
  publierContexteAdmin,
  type ChampAdmin,
  type ContexteOnglet,
} from "./adminContexte";

/**
 * Branch panneau ↔ agent : publie le contexte courant et enregistre la
 * fonction qui applique les éditions au formulaire local (jamais au serveur).
 */
export function useContexteAdmin(
  onglet: string,
  contexte: ContexteOnglet,
  champs: ChampAdmin[],
  appliqueur?: (editions: Record<string, unknown>[]) => void,
): void {
  const ref = useRef(appliqueur);
  ref.current = appliqueur;
  const present = Boolean(appliqueur);

  useEffect(() => {
    publierContexteAdmin(onglet, contexte, champs);
  }); // volontairement à chaque rendu : le contexte reflète TOUJOURS le formulaire

  useEffect(() => {
    if (!present) return;
    return enregistrerAppliqueurAdmin(onglet, (editions) => ref.current?.(editions));
  }, [onglet, present]);

  useEffect(() => () => effacerContexteAdmin(onglet), [onglet]);
}
