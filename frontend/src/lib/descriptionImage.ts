/** Texte alternatif des balises `![alt](/api/files/<id>…)` d'une image : lecture et remplacement.
 *  Par défaut on ne remplace QUE un alt vide ou le mot « légende » inséré par défaut (une description déjà rédigée n'est pas
 *  écrasée) ; `ecraser: true` remplace tout — c'est le choix explicite de l'administrateur dans la fenêtre de description. */
export const DESCRIPTION_MAX = 600;
const PLACEHOLDERS = new Set(["", "légende", "legende", "caption"]);

export interface ResultatDescription {
  markdown: string;
  remplacees: number;
  conservees: number;
}

const reBalises = (fileId: string) => new RegExp(`!\\[([^\\]]*)\\]\\((/api/files/${echapper(fileId)}(?:[?#][^)\\s]*)?)\\)`, "g");

/** Première description réellement rédigée (ni vide ni « légende ») parmi les balises de cette image, ou "". */
export function descriptionExistante(markdowns: string[], fileId: string): string {
  for (const md of markdowns) {
    for (const m of md.matchAll(reBalises(fileId))) {
      if (!PLACEHOLDERS.has(m[1].trim().toLowerCase())) return m[1];
    }
  }
  return "";
}

/** Rend un texte sûr comme alt Markdown : une seule ligne, sans crochets, borné. */
export function nettoyerDescription(texte: string): string {
  const t = texte.replace(/[\][]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > DESCRIPTION_MAX ? `${t.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : t;
}

const echapper = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function appliquerDescription(markdown: string, fileId: string, description: string, ecraser = false): ResultatDescription {
  const re = reBalises(fileId);
  let remplacees = 0;
  let conservees = 0;
  const propre = nettoyerDescription(description); // jamais de crochet ni de saut de ligne dans un alt, même saisi à la main
  const sortie = markdown.replace(re, (tout, alt: string, url: string) => {
    if (!ecraser && !PLACEHOLDERS.has(alt.trim().toLowerCase())) {
      conservees++;
      return tout;
    }
    remplacees++;
    return `![${propre}](${url})`;
  });
  return { markdown: sortie, remplacees, conservees };
}
