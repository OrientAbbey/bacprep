import type { AdminAskPayload } from "./streaming";

/** Instantané du formulaire d'édition envoyé à l'assistant admin
 * (`AdminAskPayload.epreuve`) : le sous-ensemble des champs pertinents du
 * formulaire d'édition, sans `assets`/`documents`. `statut` est dérivé
 * dans EpreuvesPanel (brouillon/a_reviser/publie). Le sujet principal est
 * l'index 0 ; les sujets supplémentaires suivent (chacun avec son corrigé
 * optionnel). */
/** Un sujet de l'éditeur avec son contenu et son corrigé Markdown numérotés. */
export interface AdminSujetContenu {
  index: number;
  contenu_markdown: string;
  corrige_markdown: string;
}

/** Instantané complet du formulaire d'épreuve, envoyé à chaque question de l'assistant. */
export interface AdminEpreuveSnapshot {
  niveau: string;
  classe: string;
  evaluation: string;
  matiere: string;
  annee: string;
  duree: string;
  coefficient: string;
  gratuit: boolean;
  statut: string;
  filieres: string[];
  /** Tous les sujets de l'épreuve (au moins un). */
  sujets: AdminSujetContenu[];
}

/** Sujet principal (index 0) de l'épreuve — ce que le prompt de l'assistant
 * connaît comme « sujet » / « corrigé » plats. */
function sujetPrincipal(form: AdminEpreuveSnapshot): AdminSujetContenu | undefined {
  return form.sujets.find((s) => s.index === 0) ?? form.sujets[0];
}

/** Messages de l'historique renvoyé avec chaque question : une réponse
 * d'assistant encore VIDE (bulle pré-créée pendant le streaming) ou un
 * message réduit à des espaces n'ont rien à apprendre au modèle — ils
 * sont écartés. */
/** Écarte les messages vides ou réduits à des espaces avant envoi au modèle. */
export function nettoyerHistorique(
  messages: { role: string; content: string }[]
): { role: string; content: string }[] {
  return messages.filter((m) => m.content.trim().length > 0);
}

/** Charge utile de l'assistant admin : `epreuve_id` optionnel — présent
 * (épreuve EN SAUVEGARDE), la conversation est persistée côté serveur et
 * `done.conversation` la restitue ; absent (épreuve pas encore enregistrée),
 * l'échange reste éphémère. Chaque envoi embarque un instantané FRAIS du
 * formulaire d'édition, lu à l'appel de `send()` (pas de prop figée). */
/** Construit la charge utile de l'assistant en mode édition, avec l'historique nettoyé et le sujet actif. */
export function buildAdminAskPayload(
  form: AdminEpreuveSnapshot,
  historique: { role: string; content: string }[],
  question: string,
  epreuve_id?: string,
  /** Rang (à partir de 1) du sujet affiché dans l'éditeur : cible par défaut des modifications. */
  sujetActifRang?: number
): AdminAskPayload {
  const principal = sujetPrincipal(form);
  return {
    question,
    historique: nettoyerHistorique(historique),
    // `epreuve_id` n'est présent DANS LE JSON que si l'épreuve est en
    // sauvegarde (JSON.stringify omet les membres undefined, mais on évite
    // aussi de créer la clé dans l'objet pour un coup d'œil sans ambiguïté).
    ...(epreuve_id ? { epreuve_id } : {}),
    epreuve: {
      niveau: form.niveau,
      classe: form.classe,
      evaluation: form.evaluation,
      matiere: form.matiere,
      annee: form.annee,
      duree: form.duree,
      coefficient: form.coefficient,
      gratuit: form.gratuit,
      statut: form.statut,
      filieres: form.filieres,
      // Champs à plat = sujet principal (compatibilité) ; `sujets` les contient TOUS et le prompt
      // backend les numérote tous pour l'assistant.
      ...(sujetActifRang ? { sujet_actif: sujetActifRang } : {}),
      contenu_markdown: principal?.contenu_markdown ?? "",
      corrige_markdown: principal?.corrige_markdown ?? "",
      sujets: form.sujets,
    },
  };
}

/** Libellé court de l'épreuve affiché dans le bandeau « Contexte : épreuve
 * en cours » du tiroir (ex. « Mathématiques · 2024 · Terminale · BAC »),
 * avec repli générique si aucun champ n'est rempli. */
/** Libellé court du bandeau de contexte (matière · année · classe · évaluation). */
export function resumeEpreuveName(form: AdminEpreuveSnapshot): string {
  const bits = [form.matiere, form.annee, form.classe, form.evaluation].filter((b) => b.trim());
  return bits.join(" · ") || "épreuve en cours";
}

/** Champs du formulaire d'édition que l'assistant peut proposer de corriger
 * via son bloc `modification-form` (métadonnées + réglages, PAS les contenus
 * sujet/corrigé ni la liste des sujets). Valeurs prêtes à être affectées à
 * `AdminEpreuveSnapshot` (types convertis par `appliquerModifications`). */
/** Nouveaux champs du formulaire proposés par l'assistant (un sous-ensemble des métadonnées). */
export interface ModificationFormulaire {
  niveau?: string;
  classe?: string;
  evaluation?: string;
  matiere?: string;
  annee?: string;
  duree?: string;
  coefficient?: string;
  gratuit?: boolean;
  statut?: string;
  filieres?: string[];
}

/** Une paire « chercher → remplacer » d'une modification ciblée (comme un diff de VS Code). */
export interface PaireRemplacement {
  chercher: string;
  remplacer: string;
}

/** Modification visant un sujet ou un corrigé PRÉCIS (`numero` = rang, à partir de 1) : soit une
 * réécriture complète (`complet`), soit une liste de remplacements ciblés (`paires`). */
/** Modification ciblée d'un sujet ou corrigé, par extrait ou réécriture complète. */
export interface EditionSujet {
  cible: "sujet" | "corrige";
  /** Absent : le sujet actuellement affiché dans l'éditeur. */
  numero?: number;
  complet?: string;
  paires?: PaireRemplacement[];
}

/** Modifications proposées par l'assistant admin, extraites des blocs fencés de sa réponse :
 * - « ```modification-sujet|corrige[:N] » : réécriture complète du sujet/corrigé (N = rang) ;
 * - « ```remplacer-sujet|corrige[:N] » : remplacements ciblés `<<<<<<< CHERCHER … ======= … >>>>>>> REMPLACER` ;
 * - « ```modification-form » : objet JSON de métadonnées.
 * `sujet`/`corrige` : réécritures SANS numéro (sujet affiché) ; `editions` : tout le reste. */
/** Ensemble des modifications proposées par l'assistant pour une épreuve. */
export interface ModificationsEpreuve {
  sujet?: string;
  corrige?: string;
  form?: ModificationFormulaire;
  editions?: EditionSujet[];
}

// Clôture de même longueur que l'ouverture (```` possible quand le contenu contient lui-même des ```).
const BLOC_MODIFICATION_RE = /(`{3,})(modification|remplacer)-(sujet|corrige|form)(?::(\d+))?[ \t]*\r?\n([\s\S]*?)(?:\1(?!`)|$)/g;
const PAIRE_RE = /<<<<<<< CHERCHER[ \t]*\r?\n([\s\S]*?)\r?\n?=======[ \t]*\r?\n([\s\S]*?)\r?\n?>>>>>>> REMPLACER/g;

/** Extrait les blocs de modification d'une réponse d'assistant (sans les marqueurs, lignes de fin
 * excédentaires retirées). Le bloc `form` est un JSON validé avant d'être pris en compte ; un bloc
 * invalide est ignoré (on n'applique jamais de données corrompues). Aucun bloc : `{}`. */
/** Analyse la réponse Markdown et extrait les blocs de modification reconnus. */
export function extraireModifications(markdown: string): ModificationsEpreuve {
  const out: ModificationsEpreuve = {};
  const editions: EditionSujet[] = [];
  let m: RegExpExecArray | null;
  BLOC_MODIFICATION_RE.lastIndex = 0;
  while ((m = BLOC_MODIFICATION_RE.exec(markdown)) !== null) {
    const [, , verbe, cible, num, corps] = m;
    const numero = num ? Number(num) : undefined;
    if (cible === "form") {
      try {
        const json = JSON.parse(corps.replace(/\s+$/, ""));
        if (json && typeof json === "object" && !Array.isArray(json)) out.form = json as ModificationFormulaire;
      } catch {
        // JSON invalide : bloc ignoré.
      }
      continue;
    }
    const c = cible as "sujet" | "corrige";
    if (verbe === "remplacer") {
      const paires: PaireRemplacement[] = [];
      let p: RegExpExecArray | null;
      PAIRE_RE.lastIndex = 0;
      while ((p = PAIRE_RE.exec(corps)) !== null) paires.push({ chercher: p[1], remplacer: p[2] });
      if (paires.length) editions.push({ cible: c, numero, paires });
    } else if (numero === undefined) {
      out[c] = corps.replace(/\s+$/, "");
    } else {
      editions.push({ cible: c, numero, complet: corps.replace(/\s+$/, "") });
    }
  }
  if (editions.length) out.editions = editions;
  return out;
}

const CLE_AUTO = "bacprep-assistant-admin-auto";

/** « Appliquer automatiquement » : activé par défaut, préférence mémorisée sur l'appareil. */
export function applicationAutoInitiale(): boolean {
  try {
    return localStorage.getItem(CLE_AUTO) !== "0";
  } catch {
    return true;
  }
}
/** Mémorise la préférence « appliquer automatiquement » dans localStorage (best-effort). */
export function memoriserApplicationAuto(v: boolean): void {
  try {
    localStorage.setItem(CLE_AUTO, v ? "1" : "0");
  } catch {
    /* préférence non mémorisée */
  }
}

/** Identifiant d'un brouillon (`brouillon:<id>` = clé de sa conversation) : 128 bits aléatoires, sans dépendre du
 * contexte sécurisé que demande `crypto.randomUUID`. */
/** Génère un identifiant aléatoire pour une nouvelle épreuve non encore enregistrée. */
export const nouvelIdBrouillon = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Indique si une réponse contient au moins une modification applicable. */
export function aDesModifications(m: ModificationsEpreuve): boolean {
  return Object.values(m).some(Boolean);
}

type FormulaireSansStatut = Omit<AdminEpreuveSnapshot, "statut">;
const CHAMPS_FORMULAIRE = ["niveau", "classe", "evaluation", "annee", "matiere", "duree", "coefficient", "gratuit", "filieres"] as const;

/** Clés des champs que `apres` change par rapport à `avant` : un champ du formulaire (« matiere »…),
 * « sujet:<index> » ou « corrige:<index> ». */
/** Liste les champs dont la valeur a changé entre deux instantanés (pour le surlignage). */
export function champsModifies(avant: FormulaireSansStatut, apres: FormulaireSansStatut): string[] {
  return [
    ...CHAMPS_FORMULAIRE.filter((c) => JSON.stringify(avant[c]) !== JSON.stringify(apres[c])),
    ...apres.sujets.flatMap((s) => {
      const a = avant.sujets.find((x) => x.index === s.index);
      return [
        ...(a?.contenu_markdown !== s.contenu_markdown ? [`sujet:${s.index}`] : []),
        ...(a?.corrige_markdown !== s.corrige_markdown ? [`corrige:${s.index}`] : []),
      ];
    }),
  ];
}

/** Résultat d'une paire chercher/remplacer : succès ou raison de l'échec (introuvable, ambigu). */
export interface ResultatPaire {
  ok: boolean;
  raison?: "introuvable" | "ambigu";
}

/** Applique les paires, dans l'ordre, sur `texte`. Le « chercher » doit exister UNE SEULE fois
 * (sinon la paire est refusée : on ne devine pas l'endroit) ; l'écart de fins de ligne ou
 * d'espaces en bout de ligne est toléré. « chercher » vide = ajout à la fin du contenu. */
/** Applique les paires de remplacement sur un texte et renvoie le texte modifié avec le détail des résultats. */
export function appliquerPaires(texte: string, paires: PaireRemplacement[]): { texte: string; resultats: ResultatPaire[] } {
  const resultats: ResultatPaire[] = [];
  let courant = texte;
  for (const { chercher, remplacer } of paires) {
    if (chercher.trim() === "") {
      courant = courant.trim() === "" ? remplacer : `${courant.replace(/\s+$/, "")}\n\n${remplacer}`;
      resultats.push({ ok: true });
      continue;
    }
    const pos = occurrences(courant, chercher);
    if (pos.length === 1) {
      courant = courant.slice(0, pos[0]) + remplacer + courant.slice(pos[0] + chercher.length);
      resultats.push({ ok: true });
      continue;
    }
    if (pos.length > 1) {
      resultats.push({ ok: false, raison: "ambigu" });
      continue;
    }
    const tolere = remplacerParLignes(courant, chercher, remplacer);
    if (tolere !== null) {
      courant = tolere;
      resultats.push({ ok: true });
    } else {
      resultats.push({ ok: false, raison: "introuvable" });
    }
  }
  return { texte: courant, resultats };
}

function occurrences(texte: string, aiguille: string): number[] {
  const out: number[] = [];
  for (let i = texte.indexOf(aiguille); i !== -1; i = texte.indexOf(aiguille, i + aiguille.length)) out.push(i);
  return out;
}

/** Repli tolérant : compare ligne à ligne en ignorant fins de ligne et espaces de fin de ligne. */
function remplacerParLignes(texte: string, chercher: string, remplacer: string): string | null {
  const norm = (l: string) => l.replace(/\s+$/, "");
  const lignes = texte.split(/\r?\n/);
  const cible = chercher.split(/\r?\n/).map(norm);
  while (cible.length && cible[cible.length - 1] === "") cible.pop();
  if (!cible.length) return null;
  const debuts: number[] = [];
  for (let i = 0; i + cible.length <= lignes.length; i++) {
    if (cible.every((c, k) => norm(lignes[i + k]) === c)) debuts.push(i);
  }
  if (debuts.length !== 1) return null;
  const i = debuts[0];
  lignes.splice(i, cible.length, ...remplacer.split(/\r?\n/));
  return lignes.join("\n");
}

/** Résultat d'une modification ciblée : libellé lisible, succès et raison éventuelle. */
export interface ResultatEdition {
  libelle: string;
  ok: boolean;
  /** Message d'échec lisible (passage introuvable, numéro inconnu…). */
  raison?: string;
}

/** Applique des éditions à une liste de sujets de formulaire (sans la modifier) : renvoie les
 * nouveaux sujets et un résultat par édition. `rangActif` : sujet visé quand `numero` est absent. */
/** Applique une liste de modifications aux sujets/corrigés et renvoie les nouveaux tableaux avec leur résultat. */
export function appliquerEditions<T extends { contenu_markdown: string; corrige_markdown: string }>(
  sujets: T[],
  editions: EditionSujet[],
  rangActif: number
): { sujets: T[]; resultats: ResultatEdition[] } {
  const copie = sujets.map((s) => ({ ...s }));
  const resultats: ResultatEdition[] = [];
  for (const ed of editions) {
    const rang = ed.numero ?? rangActif;
    const libelle = `${ed.cible === "sujet" ? "sujet" : "corrigé"} ${rang}`;
    const sujet = copie[rang - 1];
    if (!sujet) {
      resultats.push({ libelle, ok: false, raison: `le sujet ${rang} n'existe pas` });
      continue;
    }
    const cle = ed.cible === "sujet" ? "contenu_markdown" : "corrige_markdown";
    if (ed.complet !== undefined) {
      sujet[cle] = ed.complet;
      resultats.push({ libelle, ok: true });
      continue;
    }
    const { texte, resultats: rp } = appliquerPaires(sujet[cle], ed.paires ?? []);
    const echec = rp.find((r) => !r.ok);
    // Tout ou rien par édition : une paire refusée n'applique pas les autres (le texte resterait incohérent).
    if (echec) {
      resultats.push({ libelle, ok: false, raison: echec.raison === "ambigu" ? "extrait présent plusieurs fois" : "extrait introuvable (le texte a peut-être changé)" });
    } else {
      sujet[cle] = texte;
      resultats.push({ libelle, ok: true });
    }
  }
  return { sujets: copie, resultats };
}
