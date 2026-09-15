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