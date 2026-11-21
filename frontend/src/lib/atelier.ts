import { verifierFormule } from "./renduMath";
import { streamEventSource } from "./streaming";

/**
 * Atelier d'exercices : client du flux `POST /api/admin/generation-exercices`
 * et contrôles faits CÔTÉ NAVIGATEUR (KaTeX n'existe pas côté serveur).
 *
 * Console admin : messages en français uniquement, comme le reste du
 * back-office.
 */

/** Étapes successives de la génération d'un sujet par l'atelier IA. */
export type CodeEtape = "plan" | "exercice" | "situation" | "corrige" | "reparation";

/** Un contrôle automatique du texte généré (erreur ou avertissement) avec ses paramètres. */
export interface ControleAtelier {
  niveau: "erreur" | "avertissement";
  code: string;
  params: Record<string, unknown>;
}

/** Événements SSE de l'atelier : étape de progression, résultat ou erreur. */
export type EvenementAtelier =
  | { type: "etape"; code: CodeEtape; n: number; total: number; k?: number }
  | { type: "resultat"; sujet: string; corrige: string; controles: ControleAtelier[] }
  | { type: "erreur"; code: "indisponible" | "interne"; etape: number };

/** Paramètres envoyés à l'atelier : thème, nombre d'exercices, consignes et épreuve cible. */
export interface DemandeAtelier {
  theme: string;
  nb_exercices: number;
  consignes: string;
  epreuve_id?: string;
  meta: { matiere: string; classe: string; evaluation: string; filieres: string[] };
}

/** Lance la génération et transmet chaque événement SSE au callback ; le signal permet l'annulation. */
export function genererExercices(demande: DemandeAtelier, onEvent: (e: EvenementAtelier) => void, signal?: AbortSignal): Promise<void> {
  return streamEventSource<EvenementAtelier>("/api/admin/generation-exercices", demande, onEvent, signal);
}

/** Formules `$...$` et `$$...$$` du Markdown (hors `\$` échappé). */
export function extraireFormules(markdown: string): { formule: string; bloc: boolean }[] {
  const texte = markdown.replace(/\\\$/g, "  ");
  const formules: { formule: string; bloc: boolean }[] = [];
  const sansBlocs = texte.replace(/\$\$([\s\S]+?)\$\$/g, (_, f: string) => {
    formules.push({ formule: f.trim(), bloc: true });
    return " ";
  });
  for (const m of sansBlocs.matchAll(/\$([^$\n]+?)\$/g)) formules.push({ formule: m[1].trim(), bloc: false });
  return formules;
}

const MAX_FORMULES_SIGNALEES = 5;

/** Contrôle STRICT : chaque formule est compilée par KaTeX avec
 * `throwOnError` ; une formule qui ne se compile pas s'afficherait en rouge
 * pour l'élève. `ou` dit où se trouve le texte contrôlé (« sujet » ou
 * « corrige »). Au plus 5 formules sont détaillées. */
/** Contrôle les formules `$...$` / `$$...$$` d'un sujet ou corrigé et renvoie les anomalies trouvées. */
export function verifierFormules(markdown: string, ou: "sujet" | "corrige"): ControleAtelier[] {
  const controles: ControleAtelier[] = [];
  for (const { formule, bloc } of extraireFormules(markdown)) {
    try {
      verifierFormule(formule, bloc);
    } catch (e) {
      if (controles.length < MAX_FORMULES_SIGNALEES) {
        const message = (e instanceof Error ? e.message : String(e)).replace(/^KaTeX parse error:\s*/i, "").slice(0, 120);
        controles.push({ niveau: "erreur", code: "formule_invalide", params: { ou, formule: formule.slice(0, 60), message } });
      }
    }
  }
  return controles;
}

/** Ajoute `ajout` à la suite de `existant`, séparés par une ligne vide (ou le
 * remplace s'il est vide). */
/** Ajoute un texte généré à la fin d'un contenu existant, en gardant un seul séparateur propre. */
export function ajouterALaSuite(existant: string, ajout: string): string {
  const base = existant.replace(/\s+$/, "");
  return base ? `${base}\n\n${ajout.trim()}\n` : `${ajout.trim()}\n`;
}
