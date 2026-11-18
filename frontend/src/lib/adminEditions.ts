import type { ChampAdmin } from "./adminContexte";

/** Éditions de formulaire produites par l'agent (blocs ```edition {…}```).
 *  Elles sont appliquées au state local du panneau : RIEN n'est envoyé au
 *  serveur ici — la sauvegarde reste une action distincte, approuvée. */
export interface EditionFormulaire {
  champs: Record<string, unknown>;
}

const BLOC = /```edition[ \t]*\r?\n?([\s\S]*?)```/g;

/** Sépare le texte affichable des éditions ; un bloc invalide est ignoré.
 *  Quand `champs` est fourni, seules les clés déclarées par le panneau sont
 *  conservées : l'agent ne peut pas écraser un champ qu'il ne connaît pas. */
export function extraireEditions(
  texte: string,
  champs?: ChampAdmin[],
): { texte: string; editions: EditionFormulaire[] } {
  const editions: EditionFormulaire[] = [];
  const connues = champs?.map((c) => c.cle);
  const reste = texte.replace(BLOC, (_, json: string) => {
    try {
      const objet = JSON.parse(json);
      const brut = objet?.champs;
      if (brut && typeof brut === "object" && !Array.isArray(brut)) {
        const retenu: Record<string, unknown> = {};
        for (const [cleBrut, valeur] of Object.entries(brut)) {
          // Le contexte est affiché au modèle avec des préfixes
          // (`formulaire_exercice.sujet`) : on accepte aussi ces clés.
          const cle = cleBrut.includes(".") ? cleBrut.slice(cleBrut.lastIndexOf(".") + 1) : cleBrut;
          if (!connues || connues.includes(cle)) retenu[cle] = valeur;
        }
        if (Object.keys(retenu).length) editions.push({ champs: retenu });
      }
    } catch {
      /* JSON invalide : rien à appliquer */
    }
    return "";
  });
  return { texte: reste.trim(), editions };
}

/** Applique une suite d'éditions à un formulaire en respectant le type des
 *  champs déclarés (un booléen reste un booléen, un nombre reste un nombre). */
export function fusionnerEditions<T extends Record<string, unknown>>(
  form: T,
  editions: EditionFormulaire[],
  champs: ChampAdmin[] = [],
): T {
  let resultat: Record<string, unknown> = { ...form };
  for (const edition of editions) {
    for (const [cle, valeur] of Object.entries(edition.champs)) {
      const champ = champs.find((c) => c.cle === cle);
      if (champ?.type === "boolean") {
        resultat[cle] = typeof valeur === "string"
          ? !["false", "non", "0", ""].includes(valeur.trim().toLowerCase())
          : Boolean(valeur);
      } else if (champ?.type === "number") resultat[cle] = Number(valeur);
      else resultat[cle] = valeur;
    }
  }
  return resultat as T;
}
