import { expect, it } from "vitest";
import en from "./en.json";

// Interface élève uniquement : la console admin reste volontairement en français.
const sources = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.*", "!../pages/admin/**", "!../**/*[Aa]dmin*", "!../i18n.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Chaînes en position de clé d'un appel `t(…)` : premier argument seulement,
 * et seulement là où une VALEUR est attendue (début, branches d'un ternaire
 * `? … : …`, repli `?? …`). Les comparaisons (`x === "gratuit"`) et les clés
 * calculées (`t(variable)`) ne sont pas des clés : ces dernières sont
 * couvertes par `CLES_SERVEUR`. */
function clesT(code: string): string[] {
  const sansCommentaires = code
    .split(/\r?\n/)
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? "" : l))
    .join("\n");
  const cles: string[] = [];
  const appel = /(^|[^\w$.])t\(/g;
  while (appel.exec(sansCommentaires)) {
    // Premier argument : jusqu'à la virgule de niveau 0.
    let profondeur = 1;
    let argument = "";
    let chaine: string | null = null;
    for (let i = appel.lastIndex; i < sansCommentaires.length && profondeur > 0; i++) {
      const c = sansCommentaires[i];
      if (chaine) {
        if (c === "\\") {
          argument += c + (sansCommentaires[++i] ?? "");
          continue;
        }
        if (c === chaine) chaine = null;
        argument += c;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        chaine = c;
        argument += c;
        continue;
      }
      if (c === "(") profondeur++;
      else if (c === ")") {
        profondeur--;
        if (profondeur === 0) break;
      } else if (c === "," && profondeur === 1) break;
      argument += c;
    }
    // Littéraux situés à une position de valeur, au niveau 0 de l'argument.
    let attenduValeur = true;
    let niveau = 0;
    for (let i = 0; i < argument.length; i++) {
      const c = argument[i];
      if (/\s/.test(c)) continue;
      if (c === '"') {
        let j = i + 1;
        let brut = "";
        while (j < argument.length && argument[j] !== '"') {
          if (argument[j] === "\\") brut += argument[j++];
          brut += argument[j++];
        }
        if (attenduValeur) cles.push(JSON.parse(`"${brut}"`) as string);
        attenduValeur = false;
        i = j;
        continue;
      }
      if (c === "(" || c === "[") {
        niveau++;
        attenduValeur = false;
        continue;
      }
      if (c === ")" || c === "]") {
        niveau--;
        attenduValeur = false;
        continue;
      }
      if (niveau > 0) continue;
      if (c === "?") {
        if (argument[i + 1] === "?") i++; // repli `??`
        attenduValeur = true;
        continue;
      }
      if (c === ":" || (c === "|" && argument[i + 1] === "|")) {
        attenduValeur = true;
        if (c === "|") i++;
        continue;
      }
      attenduValeur = false;
    }
  }
  return cles;
}

it('chaque t("…") de l\'interface élève a sa traduction anglaise', () => {
  expect(Object.keys(sources).length).toBeGreaterThan(20);
  const manquantes: string[] = [];
  const vues = new Set<string>();
  for (const [fichier, code] of Object.entries(sources)) {
    for (const cle of clesT(code)) {
      vues.add(cle);
      if (!(cle in en)) manquantes.push(`${fichier} : ${cle}`);
    }
  }
  // Garde-fou : si l'analyse ne trouvait plus de clés, le test passerait à vide.
  expect(vues.size).toBeGreaterThan(400);
  expect(manquantes).toEqual([]);
});

// Chaînes écrites par le SERVEUR et traduites à l'affichage (`t(v)`,
// `t(a.cle)`, `t(event.message)`…) : absentes du code élève sous forme de
// littéraux. Sources : core/subscriptions.py (SCOPE_LABELS), routers/me.py
// (gabarits d'activité), routers/assistant.py et core/assistant.py (messages
// d'erreur), lib/activite.ts (statuts de la base), lib/libelleDiscussion.ts.
const CLES_SERVEUR = [
  // Portées d'abonnement
  "Épreuve précise",
  "Matière, année précise",
  "Matière (toutes années)",
  "Année (toutes matières)",
  "Série complète",
  // Statuts stockés en base (sans accent), traduits par lib/activite.ts
  "actif",
  "annulé",
  "en attente",
  "confirmé",
  // Gabarits d'activité (routers/me.py)
  "Connexion à ton compte (mobile)",
  "Connexion à ton compte (ordinateur)",
  "Consultation de {matiere} — {classe} ({evaluation} {annee})",
  "Abonnement {statut} — {portee}",
  "Paiement confirmé — {montant} FCFA ({provider})",
  "Note sur {matiere} — {classe} ({evaluation} {annee})",
  "Note personnelle",
  "Discussion « {libelle} »",
  // Libellés de discussion par défaut
  "Discussion générale",
  "Passage : {texte}",
  // Messages d'erreur du serveur
  "Votre session a été fermée.",
  "Une erreur est survenue côté serveur.",
  "Discussion introuvable (supprimée entre-temps).",
  "Les fournisseurs d'IA sont temporairement indisponibles — réessaie dans quelques minutes.",
  "Trop de questions à l'assistant — réessaie dans quelques minutes",
  "Quota quotidien de l'assistant atteint — reviens demain",
  "L'assistant est très sollicité aujourd'hui — réessaie plus tard",
  "Tu as refusé le stockage de tes conversations IA — modifie ton choix dans ton profil.",
];

it("les mots du serveur traduits à l'affichage ont leur traduction", () => {
  expect(CLES_SERVEUR.filter((cle) => !(cle in en))).toEqual([]);
});

it("aucune clé n'est écrite deux fois dans en.json", () => {
  // JSON.parse garde silencieusement la dernière valeur : on relit le texte.
  const brut = import.meta.glob("./en.json", { query: "?raw", import: "default", eager: true })["./en.json"] as string;
  const vues = new Map<string, number>();
  for (const ligne of brut.split(/\r?\n/)) {
    const m = /^\s*"((?:[^"\\]|\\.)*)"\s*:/.exec(ligne);
    if (!m) continue;
    const cle = JSON.parse(`"${m[1]}"`) as string;
    vues.set(cle, (vues.get(cle) ?? 0) + 1);
  }
  expect([...vues].filter(([, n]) => n > 1).map(([cle]) => cle)).toEqual([]);
});
