import { useEffect, useRef } from "react";
import {
  effacerContexteAdmin,
  enregistrerAppliqueurAdmin,
  enregistrerOuvreurAdmin,
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
  ouvreur?: (cible: string) => boolean,
): void {
  const ref = useRef(appliqueur);
  ref.current = appliqueur;
  const ouvreurRef = useRef(ouvreur);
  ouvreurRef.current = ouvreur;
  const present = Boolean(appliqueur);
  const ouvrable = Boolean(ouvreur);

  useEffect(() => {
    publierContexteAdmin(onglet, contexte, champs);
  }); // volontairement à chaque rendu : le contexte reflète TOUJOURS le formulaire

  useEffect(() => {
    if (!present) return;
    return enregistrerAppliqueurAdmin(onglet, (editions) => ref.current?.(editions));
  }, [onglet, present]);

  useEffect(() => {
    if (!ouvrable) return;
    return enregistrerOuvreurAdmin(onglet, (cible) => ouvreurRef.current?.(cible) ?? false);
  }, [onglet, ouvrable]);

  useEffect(() => () => effacerContexteAdmin(onglet), [onglet]);
}
