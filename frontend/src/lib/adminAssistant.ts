import type { AdminAskPayload } from "./streaming";

/** Instantané du formulaire d'édition envoyé à l'assistant admin
 * (`AdminAskPayload.epreuve`) : le sous-ensemble des champs pertinents du
 * formulaire d'édition, sans `assets`/`documents`. `statut` est dérivé
 * dans EpreuvesPanel (brouillon/a_reviser/publie). */
export interface AdminEpreuveSnapshot {
  niveau: string;
  classe: string;
  evaluation: string;
  matiere: string;
  annee: string;
  session: string;
  duree: string;
  coefficient: string;
  gratuit: boolean;
  statut: string;
  filieres: string[];
  contenu_markdown: string;
  corrige_markdown: string;
}

/** Messages de l'historique renvoyé avec chaque question : une réponse
 * d'assistant encore VIDE (bulle pré-créée pendant le streaming) ou un
 * message réduit à des espaces n'ont rien à apprendre au modèle — ils
 * sont écartés. */
export function nettoyerHistorique(
  messages: { role: string; content: string }[]
): { role: string; content: string }[] {
  return messages.filter((m) => m.content.trim().length > 0);
}

/** Charge utile ÉPHÉMÈRE de l'assistant admin : jamais de
 * `conversation_id` (rien n'est persisté côté serveur, `done.conversation`
 * vaut null) — chaque envoi embarque un instantané FRAIS du formulaire
 * d'édition, lu à l'appel de `send()` (pas de prop figée). */
export function buildAdminAskPayload(
  form: AdminEpreuveSnapshot,
  historique: { role: string; content: string }[],
  question: string
): AdminAskPayload {
  return {
    question,
    historique: nettoyerHistorique(historique),
    epreuve: {
      niveau: form.niveau,
      classe: form.classe,
      evaluation: form.evaluation,
      matiere: form.matiere,
      annee: form.annee,
      session: form.session,
      duree: form.duree,
      coefficient: form.coefficient,
      gratuit: form.gratuit,
      statut: form.statut,
      filieres: form.filieres,
      contenu_markdown: form.contenu_markdown,
      corrige_markdown: form.corrige_markdown,
    },
  };
}

/** Libellé court de l'épreuve affiché dans le bandeau « Contexte : épreuve
 * en cours » du tiroir (ex. « Mathématiques · 2024 · Terminale · BAC »),
 * avec repli générique si aucun champ n'est rempli. */
export function resumeEpreuveName(form: AdminEpreuveSnapshot): string {
  const bits = [form.matiere, form.annee, form.classe, form.evaluation].filter((b) => b.trim());
  return bits.join(" · ") || "épreuve en cours";
}

/** Modifications du sujet/corrigé proposées par l'assistant admin, extraites
 * des blocs fencés spéciaux de sa réponse (« ```modification-sujet … ``` »
 * et « ```modification-corrige … ``` ») que le prompt backend lui demande
 * de produire quand l'admin lui demande de réécrire un contenu. */
export interface ModificationsEpreuve {
  sujet?: string;
  corrige?: string;
}

const BLOC_MODIFICATION_RE = /```modification-(sujet|corrige)\s*\n([\s\S]*?)(?:```|$)/g;

/** Extrait les blocs de modification d'une réponse d'assistant : renvoie
 * un objet `{ sujet?, corrige? }` avec le Markdown complet révisé (lignes
 * de fin excédentaires retirées), sans les marqueurs. Une réponse sans
 * bloc renvoie `{}` (rien à appliquer). */
export function extraireModifications(markdown: string): ModificationsEpreuve {
  const out: ModificationsEpreuve = {};
  let m: RegExpExecArray | null;
  BLOC_MODIFICATION_RE.lastIndex = 0;
  while ((m = BLOC_MODIFICATION_RE.exec(markdown)) !== null) {
    const contenu = m[2].replace(/\s+$/, "");
    if (m[1] === "sujet") out.sujet = contenu;
    else out.corrige = contenu;
  }
  return out;
}