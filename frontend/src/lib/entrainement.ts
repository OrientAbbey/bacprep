/** Entraînement : exercices fabriqués par des gabarits paramétrés
 * (voir `backend/app/core/gabarits.py`). Types des réponses de
 * des routes `/api/entrainement/...` et `/api/admin/gabarits/...`, et petits
 * utilitaires. */

export interface ResumeGabarit {
  id: string;
  titre: string;
  matiere: string;
  classes: string[];
  chapitre: string;
  difficulte: number;
  total_points: number;
}

export interface QuestionVariante {
  enonce: string;
  points: number;
}

export interface Variante {
  id: string;
  titre: string;
  graine: number;
  enonce: string;
  questions: QuestionVariante[];
  total_points: number;
}

export interface CorrectionQuestion {
  reponse: string;
  etapes: string;
}

export interface CorrectionVariante {
  id: string;
  graine: number;
  corrections: CorrectionQuestion[];
}

/** Variante avec ses corrections (aperçu du back-office). */
export type ApercuVariante = Variante & { corrections: CorrectionQuestion[] };

export interface RapportGabarit {
  n: number;
  echecs: number;
  defauts: number;
  enonces_distincts: number;
  exemple_erreur: string | null;
  ok: boolean;
}

export type StatutGabarit = "valide" | "a_valider" | "modifie";

export interface LigneGabarit extends ResumeGabarit {
  statut: StatutGabarit;
  valide_par: string | null;
  valide_le: string | null;
  rapport: RapportGabarit;
  signalements_ouverts: number;
}

export interface SignalementGabarit {
  id: string;
  gabarit_id: string;
  titre: string;
  graine: number;
  message: string;
  statut: string;
  email: string;
  created_at: string;
}

/** Plus grande graine acceptée par le serveur (2³¹ − 1). */
export const GRAINE_MAX = 2 ** 31 - 1;

export function graineAleatoire(): number {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0] % (GRAINE_MAX + 1);
  return Math.floor(Math.random() * (GRAINE_MAX + 1));
}

/** Graine lue dans l'URL : un entier décimal valide, sinon null (le serveur en tirera une). */
export function graineDepuisUrl(brut: string | null): number | null {
  if (brut === null || !/^\d{1,10}$/.test(brut)) return null;
  const n = Number(brut);
  return n <= GRAINE_MAX ? n : null;
}

/** Points d'une question : « 1,5 » en français, « 1.5 » en anglais ; « 2 » sans décimale inutile. */
export function formaterPoints(n: number, lang: string): string {
  const texte = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
  return lang === "fr" ? texte.replace(".", ",") : texte;
}

/** Regroupe les exercices par matière puis chapitre (ordre d'arrivée conservé,
 * il est déjà trié par le serveur). */
export function regrouper(liste: ResumeGabarit[]): { matiere: string; chapitres: { chapitre: string; exercices: ResumeGabarit[] }[] }[] {
  const matieres: { matiere: string; chapitres: { chapitre: string; exercices: ResumeGabarit[] }[] }[] = [];
  for (const ex of liste) {
    let m = matieres.find((x) => x.matiere === ex.matiere);
    if (!m) matieres.push((m = { matiere: ex.matiere, chapitres: [] }));
    let c = m.chapitres.find((x) => x.chapitre === ex.chapitre);
    if (!c) m.chapitres.push((c = { chapitre: ex.chapitre, exercices: [] }));
    c.exercices.push(ex);
  }
  return matieres;
}
