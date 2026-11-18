/** Typage minimal de l'API SmilesDrawer utilisée pour les blocs ```mol```.
 * La bibliothèque ne publie pas de champ `types` exploitable par moduleResolution=bundler. */
declare module "smiles-drawer" {
  export interface SmilesOptions {
    width?: number;
    height?: number;
    bondLength?: number;
    padding?: number;
    showCarbons?: "none" | "default" | "terminal" | "acyclic" | "all";
    isomeric?: boolean;
    experimentalSSSR?: boolean;
    compactDrawing?: boolean;
    themes?: Record<string, Record<string, string>>;
  }

  export interface SmilesTree {
    [cle: string]: unknown;
  }

  export interface SmilesDrawerNS {
    parse(smiles: string, succes: (arbre: SmilesTree) => void, erreur?: (e: Error) => void): void;
    SvgDrawer: new (options?: SmilesOptions) => {
      draw(arbre: SmilesTree, cible: Element | string, theme?: string, proprietesSeulement?: boolean): void;
    };
  }

  const SmilesDrawer: SmilesDrawerNS;
  export default SmilesDrawer;
}
