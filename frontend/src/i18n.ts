import en from "./locales/en.json";

/** Traduction FR/EN sans bibliothèque : la phrase FRANÇAISE sert de clé et de
 * valeur de repli (une clé absente de `en.json` s'affiche donc en français,
 * jamais en blanc). `t("Il y a {n} jours", { n: 3 })` interpole `{n}`. */
export type Lang = "fr" | "en";
/** Clés de traduction : chaque phrase française de `en.json`. Le typage fait
 * échouer la compilation sur une faute de frappe dans un appel `t("…")`. */
export type Cle = keyof typeof en;
const CLE = "bacprep-lang";

function initiale(): Lang {
  try {
    const v = localStorage.getItem(CLE);
    if (v === "fr" || v === "en") return v;
  } catch {
    /* stockage indisponible */
  }
  return "fr"; // français par défaut ; l'élève bascule en anglais avec le sélecteur (choix mémorisé)
}

let courante: Lang = initiale();
if (typeof document !== "undefined") document.documentElement.lang = courante;

export const getLang = (): Lang => courante;
export const locale = (): string => (courante === "en" ? "en-GB" : "fr-FR");

export function setLang(l: Lang): void {
  courante = l;
  try {
    localStorage.setItem(CLE, l);
  } catch {
    /* réglage non mémorisé */
  }
  if (typeof document !== "undefined") document.documentElement.lang = l;
}

export function t<K extends Cle>(fr: K, vars?: Record<string, string | number>): string {
  let s = courante === "en" ? (en[fr] ?? fr) : fr;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
  return s;
}

/** Traduction d'une phrase FOURNIE PAR LE SERVEUR (gabarit d'activité, message
 * d'erreur, libellé de portée, statut…). Le compilateur ne peut pas vérifier
 * ces clés : `couverture.test.ts` tient la liste de celles que le serveur
 * envoie. À réserver à ce cas — une clé écrite dans le code passe par `t()`. */
export function tDynamique(cle: string, vars?: Record<string, string | number>): string {
  return t(cle as Cle, vars);
}
