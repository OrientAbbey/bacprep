import { Sparkles, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { detailServeur } from "../lib/detailServeur";
import { useModalFocus } from "../lib/useModalFocus";
import {
  genererExercices,
  verifierFormules,
  type ControleAtelier,
  type DemandeAtelier,
  type EvenementAtelier,
} from "../lib/atelier";
import { MarkdownContent } from "./MarkdownContent";
import { Spinner } from "./Spinner";

type Phase = "saisie" | "encours" | "resultat" | "erreur";
type Etape = Extract<EvenementAtelier, { type: "etape" }>;
type Resultat = Extract<EvenementAtelier, { type: "resultat" }>;

/** Libellés des étapes du flux (le serveur n'envoie que des codes). */
const LIBELLES_ETAPE: Record<Etape["code"], string> = {
  plan: "plan du sujet",
  exercice: "exercice {k}",
  situation: "situation (Partie B)",
  corrige: "corrigé (résolution du sujet)",
  reparation: "correction du barème",
};

/** Phrases de contrôle : mêmes codes que `core/generation_exercices.py`. Une
 * clé inconnue s'affiche brute plutôt que de disparaître. */
const LIBELLES_CONTROLE: Record<string, string> = {
  exercices_manquants: "Exercice(s) absent(s) du sujet : {manquants}.",
  bareme_exercice: "Exercice {k} : les barèmes des questions font {trouve} points au lieu de {attendu}.",
  bareme_partie: "Partie {partie} : les barèmes font {trouve} points au lieu de {attendu}.",
  bareme_total: "Total du sujet : {trouve} points au lieu de {attendu}.",
  partie_b_absente: "La Partie B (compétences) est absente.",
  url_externe: "{n} lien(s) internet dans le texte : à retirer.",
  delimiteur_formule: "Un symbole $ ou $$ n'est pas refermé : une formule risque de mal s'afficher.",
  question_dupliquee: "{n} question(s) en double, par exemple : « {exemple} ».",
  corrige_exercices_manquants: "Le corrigé ne couvre pas l'exercice : {manquants}.",
  probleme_signale: "En résolvant le sujet, l'IA a signalé {n} problème(s) : {exemples}",
  formule_invalide: "Formule illisible dans le {ou} : « {formule} » — {message}",
};

/**
 * Atelier d'exercices : génère un BROUILLON de sujet + corrigé au format des
 * épreuves camerounaises. Rien n'est enregistré ni publié ici : « Insérer dans
 * l'éditeur » écrit dans le formulaire (annulable) et l'épreuve ne change que
 * par « Enregistrer ». Refusé pour une épreuve publiée.
 *
 * Console admin : textes en français uniquement (pas de `t()`).
 */
export function AtelierExercicesModal({
  meta,
  epreuveId,
  publiee,
  onInserer,
  onAnnuler,
  onClose,
}: {
  meta: DemandeAtelier["meta"];
  epreuveId?: string;
  publiee: boolean;
  /** Écrit dans l'éditeur ; rend l'identifiant d'annulation, ou null si rien n'a changé. */
  onInserer: (sujet: string, corrige: string) => string | null;
  onAnnuler: (id: string) => "ok" | "modifie" | "inconnu";
  onClose: () => void;
}) {
  const abort = useRef<AbortController | null>(null);
  const fermer = () => {
    abort.current?.abort();
    onClose();
  };
  const dialogRef = useModalFocus<HTMLDivElement>({ open: true, onClose: fermer });
  const [theme, setTheme] = useState("");
  const [nb, setNb] = useState(3);
  const [consignes, setConsignes] = useState("");
  const [phase, setPhase] = useState<Phase>("saisie");
  const [etape, setEtape] = useState<Etape | null>(null);
  const [resultat, setResultat] = useState<Resultat | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [vue, setVue] = useState<"sujet" | "corrige">("sujet");
  const [idInsertion, setIdInsertion] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  // Contrôles du serveur + contrôle strict des formules par KaTeX (disponible
  // seulement ici, dans le navigateur).
  const controles = useMemo<ControleAtelier[]>(
    () =>
      resultat
        ? [...resultat.controles, ...verifierFormules(resultat.sujet, "sujet"), ...verifierFormules(resultat.corrige, "corrige")]
        : [],
    [resultat]
  );

  function libelleEtape(e: Etape): string {
    return LIBELLES_ETAPE[e.code].replace("{k}", String(e.k ?? ""));
  }

  function libelleControle(c: ControleAtelier): string {
    const p: Record<string, string> = Object.fromEntries(
      Object.entries(c.params).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)])
    );
    if (c.code === "formule_invalide") p.ou = p.ou === "corrige" ? "corrigé" : "sujet";
    const modele = LIBELLES_CONTROLE[c.code];
    if (!modele) return c.code;
    return modele.replace(/\{(\w+)\}/g, (_, cle: string) => p[cle] ?? "");
  }

  async function lancer() {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setPhase("encours");
    setErreur(null);
    setResultat(null);
    setIdInsertion(null);
    setMessage(null);
    setEtape(null);
    let termine = false;
    try {
      await genererExercices(
        { theme: theme.trim(), nb_exercices: nb, consignes: consignes.trim(), epreuve_id: epreuveId, meta },
        (e) => {
          if (ctl.signal.aborted) return;
          if (e.type === "etape") setEtape(e);
          else if (e.type === "resultat") {
            termine = true;
            setResultat(e);
            setVue("sujet");
            setPhase("resultat");
          } else {
            termine = true;
            setErreur(
              e.code === "indisponible"
                ? `Aucun fournisseur d'IA n'a répondu (étape ${e.etape}). Réessaie dans une minute : les offres gratuites limitent les jetons par minute.`
                : `La génération a échoué (erreur interne, étape ${e.etape}). Réessaie ; si cela persiste, regarde les journaux du serveur.`
            );
            setPhase("erreur");
          }
        },
        ctl.signal
      );
      if (!termine && !ctl.signal.aborted) {
        setErreur("Impossible de joindre le serveur pour générer le brouillon.");
        setPhase("erreur");
      }
    } catch (err) {
      if (ctl.signal.aborted) return;
      const status = (err as { status?: number }).status;
      setErreur(
        status
          ? `La génération a été refusée : ${detailServeur(err) ?? String(status)}`
          : "Impossible de joindre le serveur pour générer le brouillon."
      );
      setPhase("erreur");
    }
  }

  function arreter() {
    abort.current?.abort();
    setPhase("saisie");
    setEtape(null);
  }

  function inserer() {
    if (!resultat) return;
    setIdInsertion(onInserer(resultat.sujet, resultat.corrige));
    setMessage("Inséré dans l'éditeur. Relis, corrige, puis utilise « Enregistrer ».");
  }

  function annuler() {
    if (!idInsertion) return;
    const r = onAnnuler(idInsertion);
    if (r === "modifie") setMessage("Impossible d'annuler : le texte a été modifié depuis l'insertion.");
    else {
      setIdInsertion(null);
      setMessage("Insertion annulée.");
    }
  }

  const champ = "mt-1 w-full rounded-[2px] border border-ink-soft/25 bg-paper p-3 text-sm";
  const etiquette = "mt-3 block font-mono-tag text-[10px] text-ink-soft";
  const bouton = "flex min-h-[44px] items-center gap-2 rounded-full px-4 text-sm font-medium disabled:opacity-60";
  const enCours = phase === "encours";
  const aErreurs = controles.some((c) => c.niveau === "erreur");

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm" onClick={fermer}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="atelier-titre"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-ink-soft/15 bg-paper-raised p-5 shadow-xl"
      >
        <h2 id="atelier-titre" className="font-serif-brand text-lg">
          Atelier d'exercices
        </h2>
        <p className="mt-2 text-sm text-ink-soft">
          Génère un brouillon de sujet et de corrigé au format des épreuves (Partie A : ressources, 15 points ; Partie B :
          compétences, 5 points). Rien n'est enregistré ni publié : tu relis, tu corriges, puis tu enregistres comme d'habitude.
        </p>
        <p className="mt-2 rounded border border-correction/40 p-2 text-sm text-correction">
          Texte généré par une IA : il peut contenir des erreurs de calcul, de programme ou de barème. Relis chaque question et
          chaque réponse avant de publier.
        </p>
        {publiee && (
          <p className="mt-2 rounded border border-ink-soft/30 p-2 text-sm">
            Cette épreuve est publiée. Dépublie-la ou travaille dans un brouillon : un texte généré par une IA doit être relu
            avant d'être vu des élèves.
          </p>
        )}

        <label htmlFor="atelier-theme" className={etiquette}>
          Thème ou chapitres
        </label>
        <input
          id="atelier-theme"
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          maxLength={300}
          placeholder="Ex. : suites numériques et limites"
          disabled={enCours}
          className={champ}
        />

        <label htmlFor="atelier-nb" className={etiquette}>
          Nombre d'exercices (Partie A)
        </label>
        <select id="atelier-nb" value={nb} onChange={(e) => setNb(Number(e.target.value))} disabled={enCours} className={champ}>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>

        <label htmlFor="atelier-consignes" className={etiquette}>
          Consignes supplémentaires (facultatif)
        </label>
        <textarea
          id="atelier-consignes"
          value={consignes}
          onChange={(e) => setConsignes(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="Ex. : un exercice avec une courbe à interpréter, niveau probatoire"
          disabled={enCours}
          className={champ}
        />

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {enCours ? (
            <button type="button" onClick={arreter} className={`${bouton} border border-ink-soft/25`}>
              Arrêter
            </button>
          ) : (
            <button
              type="button"
              onClick={lancer}
              disabled={publiee || theme.trim().length < 3}
              className={`${bouton} bg-ink text-paper`}
            >
              <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
              Générer le brouillon
            </button>
          )}
          <button type="button" onClick={fermer} className={`${bouton} border border-ink-soft/25`}>
            Fermer
          </button>
        </div>

        <div role="status" aria-live="polite" className="mt-3 text-sm">
          {enCours && etape && (
            <p className="flex items-center gap-2">
              <Spinner />
              Étape {etape.n} sur {etape.total} : {libelleEtape(etape)}
            </p>
          )}
        </div>
        {phase === "erreur" && erreur && (
          <p role="alert" className="mt-2 rounded border border-correction/40 p-2 text-sm text-correction">
            {erreur}
          </p>
        )}

        {phase === "resultat" && resultat && (
          <section className="mt-4 border-t border-ink-soft/10 pt-4" aria-labelledby="atelier-resultat">
            <h3 id="atelier-resultat" className="font-serif-brand text-base">
              Brouillon généré
            </h3>

            <h4 className="mt-3 font-mono-tag text-[10px] text-ink-soft">Contrôles automatiques</h4>
            {controles.length === 0 ? (
              <p className="mt-1 text-sm">
                Aucun problème détecté par les contrôles automatiques. Ils ne remplacent pas ta relecture.
              </p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm">
                {controles.map((c, i) => (
                  <li key={`${c.code}-${i}`} className="flex gap-2">
                    <span className={`shrink-0 font-medium ${c.niveau === "erreur" ? "text-correction" : "text-ink"}`}>
                      {c.niveau === "erreur" ? "Erreur" : "À vérifier"} :
                    </span>
                    <span>{libelleControle(c)}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 flex gap-2" role="group" aria-label="Brouillon généré">
              {(["sujet", "corrige"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={vue === v}
                  onClick={() => setVue(v)}
                  className={`min-h-[44px] rounded-full border px-4 text-sm ${
                    vue === v ? "border-ink bg-ink text-paper" : "border-ink-soft/25"
                  }`}
                >
                  {v === "sujet" ? "Sujet" : "Corrigé"}
                </button>
              ))}
            </div>
            <div
              role="region"
              tabIndex={0}
              aria-label={vue === "sujet" ? "Sujet" : "Corrigé"}
              className="prose-exam mt-2 max-h-72 overflow-y-auto rounded border border-ink-soft/15 bg-paper p-3 text-sm"
            >
              <MarkdownContent content={vue === "sujet" ? resultat.sujet : resultat.corrige} variant="epreuve" />
            </div>

            <p className="mt-3 text-xs text-ink-soft">
              Le texte est ajouté à la suite du sujet et du corrigé affichés dans l'éditeur ; tu peux annuler.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={inserer}
                disabled={idInsertion !== null}
                className={`${bouton} bg-ink text-paper ${aErreurs ? "ring-2 ring-correction/60" : ""}`}
              >
                Insérer dans l'éditeur
              </button>
              {idInsertion !== null && (
                <button type="button" onClick={annuler} className={`${bouton} border border-ink-soft/25`}>
                  <Undo2 size={16} strokeWidth={1.75} aria-hidden="true" />
                  Annuler l'insertion
                </button>
              )}
            </div>
            <p role="status" aria-live="polite" className="mt-2 text-sm">
              {message}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
