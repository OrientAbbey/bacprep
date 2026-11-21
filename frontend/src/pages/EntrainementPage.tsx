import { ArrowLeft, Check, Link2, Printer, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { BanqueDifficulte, BanqueGenerationInput, BanqueGenerationOutput, BanqueMode } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Combobox } from "../components/Combobox";
import { MarkdownContent } from "../components/MarkdownContent";
import { prechargerMol } from "../components/MolBlock";
import { Spinner } from "../components/Spinner";
import { useToast } from "../components/Toast";
import { getLang, t } from "../i18n";
import { detailServeur } from "../lib/detailServeur";
import {
  type CorrectionVariante,
  type ResumeGabarit,
  type Variante,
  difficultesDe,
  filtrerExercices,
  formaterPoints,
  graineAleatoire,
  graineDepuisUrl,
  matieresDe,
  regrouper,
} from "../lib/entrainement";
import { copierTexte } from "../lib/pressePapiers";
import { classeLabel } from "../lib/referentiel";

/**
 * Entraînement : des exercices dont les valeurs changent à chaque fois, avec
 * correction détaillée. `?g=<exercice>&graine=<n>` : la graine est dans
 * l'adresse, donc la même adresse ramène exactement la même variante (partage,
 * signalement). Aucun exercice n'apparaît ici sans avoir été validé par un
 * enseignant.
 */

/** Page d'entraînement : gabarits validés et composition d'épreuves depuis la Banque. */
export function EntrainementPage() {
  const [params] = useSearchParams();
  const id = params.get("g");
  return id ? <Exercice key={id} id={id} /> : <Liste />;
}

function Liste() {
  const [params] = useSearchParams();
  const [liste, setListe] = useState<ResumeGabarit[] | null>(null);
  const [erreur, setErreur] = useState(false);
  const [essai, setEssai] = useState(0);
  const [matiere, setMatiere] = useState("");
  const [difficulte, setDifficulte] = useState("");
  const [composer, setComposer] = useState(() => params.has("gen"));

  useEffect(() => {
    const ctl = new AbortController();
    setListe(null);
    setErreur(false);
    api
      .get<ResumeGabarit[]>("/api/entrainement/gabarits", undefined, ctl.signal)
      .then(setListe)
      .catch(() => {
        if (!ctl.signal.aborted) setErreur(true);
      });
    return () => ctl.abort();
  }, [essai]);

  const filtres = liste ? filtrerExercices(liste, { matiere, difficulte }) : [];
  const filtreActif = matiere !== "" || difficulte !== "";
  const reinitialiser = () => {
    setMatiere("");
    setDifficulte("");
  };

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="font-serif-brand text-2xl">{t("Entraînement")}</h1>
        <p className="mt-2 text-sm text-ink-soft">
          {t("Des exercices à refaire autant de fois que tu veux : à chaque fois, les valeurs changent. Cherche d'abord sur ta feuille, puis affiche la correction détaillée.")}
        </p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
        <div>
          <h2 className="font-serif-brand text-lg">{t("Composer une épreuve")}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t("Prépare une épreuve personnalisée à partir des exercices disponibles.")}</p>
        </div>
        <button type="button" onClick={() => setComposer((value) => !value)} aria-expanded={composer} className="min-h-[44px] rounded-full bg-ink px-5 text-sm font-medium text-paper">
          {t(composer ? "Masquer le formulaire" : "Composer une épreuve")}
        </button>
      </div>
      {composer && <ComposerBanque />}

      {erreur && (
        <div role="alert" className="rounded-lg border border-correction/30 bg-correction-soft p-5 text-sm text-correction">
          <p>{t("Impossible de charger les exercices pour le moment.")}</p>
          <button type="button" onClick={() => setEssai((n) => n + 1)} className="mt-2 min-h-[44px] underline">
            {t("Réessayer")}
          </button>
        </div>
      )}
      {!liste && !erreur && (
        <p role="status" className="flex items-center gap-2 text-sm text-ink-soft">
          <Spinner /> {t("Chargement des exercices.")}
        </p>
      )}
      {liste && liste.length === 0 && (
        <p className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5 text-sm">
          {t("Aucun exercice d'entraînement n'est encore disponible. Reviens bientôt !")}
        </p>
      )}
      {liste && liste.length > 0 && (
        <div role="group" aria-label={t("Filtrer les exercices")} className="flex flex-wrap items-end gap-3">
          <Combobox
            label={t("Matière")}
            value={matiere}
            onChange={setMatiere}
            options={matieresDe(liste).map((m) => ({ value: m, label: m }))}
          />
          <Combobox
            label={t("Difficulté")}
            value={difficulte}
            onChange={setDifficulte}
            options={difficultesDe(liste).map((d) => ({ value: String(d), label: t("Difficulté {n} sur 3", { n: d }) }))}
          />
          <p role="status" className="pb-3 text-sm text-ink-soft">
            {t(filtres.length > 1 ? "{n} exercices" : "{n} exercice", { n: filtres.length })}
          </p>
          {filtreActif && (
            <button type="button" onClick={reinitialiser} className="mb-1 min-h-[44px] text-sm underline">
              {t("Réinitialiser")}
            </button>
          )}
        </div>
      )}
      {liste && liste.length > 0 && filtres.length === 0 && (
        <p className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5 text-sm">
          {t("Aucun exercice ne correspond à ces filtres.")}{" "}
          <button type="button" onClick={reinitialiser} className="min-h-[44px] underline">
            {t("Réinitialiser")}
          </button>
        </p>
      )}
      {filtres.length > 0 &&
        regrouper(filtres).map((m) => (
          <section key={m.matiere} aria-labelledby={`mat-${m.matiere}`} className="space-y-3">
            <h2 id={`mat-${m.matiere}`} className="font-serif-brand text-xl">
              {m.matiere}
            </h2>
            {m.chapitres.map((c) => (
              <div key={c.chapitre} className="space-y-2">
                <h3 className="font-mono-tag text-[11px] text-slate">{c.chapitre}</h3>
                <ul className="grid gap-2 md:grid-cols-2">
                  {c.exercices.map((ex) => (
                    <li key={ex.id} className="flex h-full flex-col rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
                      <p className="font-medium">{ex.titre}</p>
                      <p className="mt-1 text-xs text-ink-soft">
                        {t("Difficulté {n} sur 3", { n: ex.difficulte })} · {t("Classes : {liste}", { liste: ex.classes.map(classeLabel).join(", ") })}
                      </p>
                      <Link
                        to={`/entrainement?g=${encodeURIComponent(ex.id)}`}
                        className="mt-3 inline-flex min-h-[44px] w-fit items-center self-start rounded-full bg-ink px-5 text-sm font-medium text-paper"
                      >
                        {t("Faire cet exercice")}
                        <span className="sr-only"> : {ex.titre}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))}
    </section>
  );
}

interface OptionsBanque {
  matieres: string[];
  classes: string[];
  classes_meta: Record<string, { specialite_obligatoire: boolean }>;
  series: string[];
  sequences: number[];
}

function ComposerBanque() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const generationParam = params.get("gen");
  const [options, setOptions] = useState<OptionsBanque | null>(null);
  const [chargementOptions, setChargementOptions] = useState(true);
  const [classe, setClasse] = useState("terminale");
  const [matiere, setMatiere] = useState("");
  const [serie, setSerie] = useState("");
  const [mode, setMode] = useState<BanqueMode>("sequence");
  const [sequence, setSequence] = useState(1);
  const [difficulte, setDifficulte] = useState<BanqueDifficulte>("Moyen");
  const [generation, setGeneration] = useState<BanqueGenerationOutput | null>(null);
  const [corrige, setCorrige] = useState<BanqueGenerationOutput | null>(null);
  const [corrigeAffiche, setCorrigeAffiche] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [impression, setImpression] = useState<"sujet" | "corrige" | null>(null);
  const [chargementCorrige, setChargementCorrige] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [erreurOptions, setErreurOptions] = useState<string | null>(null);

  const chargerOptions = useCallback(async (signal?: AbortSignal) => {
    setChargementOptions(true);
    try {
      const values = await api.get<OptionsBanque>("/api/banque/options", undefined, signal);
      setOptions(values);
      setSequence((current) => values.sequences.includes(current) ? current : values.sequences[0] ?? 1);
      setMatiere((current) => values.matieres.includes(current) ? current : values.matieres[0] || "");
      setClasse((current) => values.classes.includes(current) ? current : values.classes[0] || "");
      setSerie((current) => current && values.series.includes(current) ? current : "");
      setErreurOptions(null);
    } catch {
      if (!signal?.aborted) setErreurOptions(t("Impossible de charger les options de génération."));
    } finally {
      if (!signal?.aborted) setChargementOptions(false);
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setOptions(null);
      setChargementOptions(false);
      return;
    }
    const ctl = new AbortController();
    void chargerOptions(ctl.signal);
    return () => ctl.abort();
  }, [chargerOptions, user?.id]);

  // Réaffichage : une adresse avec `?gen=<id>` recharge l'épreuve composée
  // (même principe que la graine de l'entraînement). Le serveur vérifie
  // la propriété : un autre élève obtient une 404.
  useEffect(() => {
    if (!generationParam || generation) return;
    let annule = false;
    api
      .get<BanqueGenerationOutput>(`/api/banque/generations/${encodeURIComponent(generationParam)}`)
      .then((saved) => {
        if (!annule) setGeneration(saved);
      })
      .catch(() => {
        /* épreuve introuvable ou non accessible : le formulaire reste vide */
      });
    return () => {
      annule = true;
    };
  }, [generationParam, generation]);

  const exercices = generation?.exercices ?? [];
  const sujetMarkdown = exercices.map((ex) => `## ${t("Exercice {n}", { n: ex.numero })}\n\n${ex.contenu ?? ""}`).join("\n\n---\n\n");
  const corrigeMarkdown = corrige?.exercices.map((ex) => `## ${t("Exercice {n}", { n: ex.numero })}\n\n${ex.contenu ?? ""}`).join("\n\n---\n\n") ?? "";
  const specialiteObligatoire = options?.classes_meta?.[classe]?.specialite_obligatoire === true;
  const parametres = useMemo<BanqueGenerationInput | null>(() => {
    if (!matiere || !classe) return null;
    if (specialiteObligatoire && !serie) return null;
    return { matiere, classe, serie: serie || undefined, mode, difficulte, ...(mode === "sequence" ? { sequence } : {}) };
  }, [matiere, classe, serie, mode, difficulte, sequence, specialiteObligatoire]);

  async function genererEpreuve() {
    if (!parametres || !user) return;
    setEnCours(true);
    setErreur(null);
    setCorrige(null);
    setCorrigeAffiche(false);
    try {
      const created = await api.post<BanqueGenerationOutput>("/api/banque/generer", parametres);
      const saved = await api.get<BanqueGenerationOutput>(`/api/banque/generations/${encodeURIComponent(created.generation_id)}`);
      setGeneration(saved);
      // L'adresse conserve l'identifiant : un rechargement remontre l'épreuve.
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.set("gen", saved.generation_id);
          return p;
        },
        { replace: true },
      );
    } catch (err) {
      setErreur(err instanceof ApiError && err.status === 403
        ? t("Cette matière n'est pas couverte par ton abonnement actif.")
        : t("L'épreuve n'a pas pu être préparée. Vérifie tes choix puis réessaie."));
    } finally {
      setEnCours(false);
    }
  }

  function imprimer(cible: "sujet" | "corrige") {
    setImpression(cible);
  }

  useEffect(() => {
    if (!impression) return;
    let annule = false;
    let minuteur: number | undefined;
    const fin = () => setImpression(null);
    window.addEventListener("afterprint", fin, { once: true });
    // Le dessin des molécules est asynchrone (chunk différé) : on attend le
    // chargement avant d'ouvrir la boîte d'impression, sinon le PDF est vide.
    void prechargerMol()
      .catch(() => undefined)
      .finally(() => {
        if (!annule) minuteur = window.setTimeout(() => window.print(), 300);
      });
    return () => {
      annule = true;
      if (minuteur !== undefined) window.clearTimeout(minuteur);
      window.removeEventListener("afterprint", fin);
    };
  }, [impression]);

  async function afficherCorrige() {
    if (corrigeAffiche) {
      setCorrigeAffiche(false);
      return;
    }
    if (!generation) return;
    if (corrige) {
      setCorrigeAffiche(true);
      return;
    }
    setChargementCorrige(true);
    setErreur(null);
    try {
      const result = await api.get<BanqueGenerationOutput>(`/api/banque/generations/${encodeURIComponent(generation.generation_id)}/corrige`);
      setCorrige(result);
      setCorrigeAffiche(true);
    } catch {
      setErreur(t("Le corrigé n'a pas pu être chargé. Réessaie."));
    } finally {
      setChargementCorrige(false);
    }
  }

  const champ = "min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm";
  const bouton = "inline-flex min-h-[44px] items-center gap-2 rounded-full border border-ink-soft/25 px-4 text-sm font-medium hover:bg-highlight-soft disabled:opacity-60";

  return (
    <section aria-labelledby="composer-banque-titre" className="space-y-4 rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
      <header>
        <h2 id="composer-banque-titre" className="font-serif-brand text-xl">{t("Composer une épreuve")}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t("Choisis ta classe, ta matière et le format de l'épreuve.")}</p>
      </header>
      {!user ? (
        <p className="rounded border border-ink-soft/15 p-3 text-sm">{t("Connecte-toi pour composer une épreuve.")} <Link to="/connexion" className="underline">{t("Se connecter")}</Link></p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs">{t("Classe")}<select value={classe} onChange={(e) => { setClasse(e.target.value); setSerie(""); }} disabled={chargementOptions || !options?.classes.length} className={`${champ} mt-1`}>{(options?.classes ?? []).map((code) => <option key={code} value={code}>{classeLabel(code)}</option>)}</select></label>
            <label className="text-xs">{t("Matière")}<select value={matiere} onChange={(e) => setMatiere(e.target.value)} disabled={chargementOptions || !options?.matieres.length} className={`${champ} mt-1`}>{(options?.matieres ?? []).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label className="text-xs">{t("Série / spécialité")}{specialiteObligatoire && <span className="text-correction"> *</span>}<select value={serie} onChange={(e) => setSerie(e.target.value)} required={specialiteObligatoire} disabled={chargementOptions || !options?.series.length} className={`${champ} mt-1`}><option value="">{specialiteObligatoire ? t("Choisis une spécialité") : t("Toutes / aucune")}</option>{(options?.series ?? []).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label className="text-xs">{t("Format de l'épreuve")}<select value={mode} onChange={(e) => setMode(e.target.value as BanqueMode)} className={`${champ} mt-1`}>
              <option value="sequence">{t("Séquence")}</option><option value="examen">{t("Examen")}</option><option value="examen_blanc">{t("Examen blanc")}</option><option value="vide">{t("Sans séquence")}</option>
            </select></label>
            {mode === "sequence" && <label className="text-xs">{t("Séquence")}<select value={sequence} onChange={(e) => setSequence(Number(e.target.value))} className={`${champ} mt-1`}>{(options?.sequences ?? []).map((n) => <option key={n} value={n}>{t("Séquence {n}", { n })}</option>)}</select></label>}
            <label className="text-xs">{t("Difficulté")}<select value={difficulte} onChange={(e) => setDifficulte(e.target.value as BanqueDifficulte)} className={`${champ} mt-1`}><option value="Facile">{t("Facile")}</option><option value="Moyen">{t("Moyenne")}</option><option value="Difficile">{t("Difficile")}</option></select></label>
          </div>
          {user && chargementOptions && <p role="status" className="text-sm text-ink-soft"><Spinner /> {t("Chargement des options de génération.")}</p>}
          {user && !chargementOptions && options && options.matieres.length === 0 && <p className="text-sm text-ink-soft">{t("Aucune matière n'est disponible pour le moment.")}</p>}
          {user && erreurOptions && !chargementOptions && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-correction"><span>{erreurOptions}</span><button type="button" onClick={() => void chargerOptions()} className="min-h-[44px] underline">{t("Réessayer")}</button></div>}
          <button type="button" onClick={() => void genererEpreuve()} disabled={!parametres || !options?.matieres.length || enCours || chargementOptions} className={`${bouton} bg-ink text-paper hover:bg-ink`}>
            {enCours ? <Spinner /> : <RefreshCw size={16} aria-hidden="true" />}{t(generation ? "Composer une autre épreuve" : "Générer l'épreuve")}
          </button>
          {erreur && !erreurOptions && <p role="alert" className="text-sm text-correction">{erreur}</p>}
        </>
      )}
      {generation && (
        <article className="space-y-4 border-t border-ink-soft/15 pt-4">
          <header><h3 className="font-serif-brand text-lg">{t("Épreuve personnalisée")}</h3><p className="text-xs text-ink-soft">{generation.parametres.matiere} · {classeLabel(generation.parametres.classe)} · {t(generation.parametres.difficulte === "Moyen" ? "Moyenne" : generation.parametres.difficulte)} · {t("{n} exercices", { n: exercices.length })}</p></header>
          {exercices.length === 0 ? <p className="rounded border border-ink-soft/15 p-3 text-sm">{t("Aucun exercice n'a pu être préparé pour ces choix. Essaie un autre format.")}</p> : (
            <ol className="space-y-3">{exercices.map((ex) => <li key={ex.numero} className="rounded border border-ink-soft/15 p-3"><h4 className="font-mono-tag text-xs text-slate">{t("Exercice {n}", { n: ex.numero })}</h4><div className="prose-exam mt-2"><MarkdownContent content={ex.contenu ?? ""} variant="epreuve" /></div>{corrigeAffiche && corrige?.exercices[ex.numero - 1] && <div className="mt-4 border-t border-ink-soft/10 pt-3"><h5 className="font-mono-tag text-xs text-valide">{t("Corrigé")}</h5><div className="prose-exam mt-2"><MarkdownContent content={corrige.exercices[ex.numero - 1].contenu ?? ""} variant="epreuve" /></div></div>}</li>)}</ol>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void afficherCorrige()} disabled={chargementCorrige || exercices.length === 0} aria-pressed={corrigeAffiche} className={`${bouton} bg-ink text-paper hover:bg-ink`}>{chargementCorrige ? <Spinner /> : <Check size={16} aria-hidden="true" />}{t(corrigeAffiche ? "Masquer la correction" : "Voir le corrigé")}</button>
            <button type="button" onClick={() => void genererEpreuve()} disabled={enCours} className={bouton}><RefreshCw size={16} aria-hidden="true" />{t("Régénérer une épreuve")}</button>
            <button type="button" onClick={() => imprimer("sujet")} className={bouton}><Printer size={16} aria-hidden="true" />{t("Imprimer l'épreuve")}</button>
            {corrige && <button type="button" onClick={() => imprimer("corrige")} className={bouton}><Printer size={16} aria-hidden="true" />{t("Imprimer le corrigé")}</button>}
          </div>
          {createPortal(
            <div className={`print-zone print-zone-sujet${impression === "sujet" ? " print-zone--actif" : ""}`}>
              <h1>{t("Épreuve personnalisée")}: {generation.parametres.matiere} — {classeLabel(generation.parametres.classe)}</h1>
              <MarkdownContent content={sujetMarkdown} variant="epreuve" />
            </div>,
            document.body,
          )}
          {corrige && createPortal(
            <div className={`print-zone print-zone-corrige${impression === "corrige" ? " print-zone--actif" : ""}`}>
              <h1>{t("Corrigé")}: {generation.parametres.matiere} — {classeLabel(generation.parametres.classe)}</h1>
              <MarkdownContent content={corrigeMarkdown} variant="epreuve" />
            </div>,
            document.body,
          )}
        </article>
      )}
    </section>
  );
}

function Exercice({ id }: { id: string }) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [params, setParams] = useSearchParams();
  const graineUrl = params.get("graine");
  const [variante, setVariante] = useState<Variante | null>(null);
  const [erreur, setErreur] = useState(false);
  const [correction, setCorrection] = useState<CorrectionVariante | null>(null);
  const [correctionAffichee, setCorrectionAffichee] = useState(false);
  const [correctionChargement, setCorrectionChargement] = useState(false);
  const [correctionErreur, setCorrectionErreur] = useState(false);
  const [signalerOuvert, setSignalerOuvert] = useState(false);
  const [message, setMessage] = useState("");
  const [envoi, setEnvoi] = useState(false);
  const [signalementEnvoye, setSignalementEnvoye] = useState(false);
  const [erreurSignalement, setErreurSignalement] = useState<string | null>(null);
  const titreRef = useRef<HTMLHeadingElement>(null);
  const derniereGraine = useRef<number | null>(null);
  const [essai, setEssai] = useState(0);

  // Charge la variante de l'adresse ; sans graine valide, le serveur en tire
  // une, qu'on écrit dans l'adresse (sans empiler l'historique).
  useEffect(() => {
    const graine = graineDepuisUrl(graineUrl);
    if (graine !== null && derniereGraine.current === graine) return; // déjà affichée (cas de l'écriture de la graine dans l'adresse)
    const ctl = new AbortController();
    setVariante(null);
    setErreur(false);
    setCorrection(null);
    setCorrectionAffichee(false);
    setCorrectionErreur(false);
    setSignalerOuvert(false);
    setSignalementEnvoye(false);
    setErreurSignalement(null);
    setMessage("");
    const q = graine === null ? "" : `?graine=${graine}`;
    api
      .get<Variante>(`/api/entrainement/gabarits/${encodeURIComponent(id)}${q}`, undefined, ctl.signal)
      .then((v) => {
        derniereGraine.current = v.graine;
        setVariante(v);
        if (graine === null) setParams({ g: id, graine: String(v.graine) }, { replace: true });
      })
      .catch(() => {
        if (!ctl.signal.aborted) setErreur(true);
      });
    return () => ctl.abort();
  }, [id, graineUrl, essai, setParams]);

  // Une nouvelle variante : le titre reprend le focus (lecteurs d'écran et
  // clavier repartent du haut).
  useEffect(() => {
    if (variante) titreRef.current?.focus();
  }, [variante?.graine]); // eslint-disable-line react-hooks/exhaustive-deps

  async function basculerCorrection() {
    if (correctionAffichee) {
      setCorrectionAffichee(false);
      return;
    }
    if (correction || !variante) {
      setCorrectionAffichee(true);
      return;
    }
    setCorrectionChargement(true);
    setCorrectionErreur(false);
    try {
      setCorrection(await api.get<CorrectionVariante>(`/api/entrainement/gabarits/${encodeURIComponent(id)}/correction?graine=${variante.graine}`));
      setCorrectionAffichee(true);
    } catch {
      setCorrectionErreur(true);
    } finally {
      setCorrectionChargement(false);
    }
  }

  async function copierLien() {
    const ok = await copierTexte(window.location.href);
    showToast(t(ok ? "Lien copié : il ramène exactement à cet exercice." : "Copie impossible : copie l'adresse de la page à la main."), ok ? "success" : "error");
  }

  async function envoyerSignalement() {
    if (!variante) return;
    setEnvoi(true);
    setErreurSignalement(null);
    try {
      await api.post(`/api/entrainement/gabarits/${encodeURIComponent(id)}/signalements`, { graine: variante.graine, message: message.trim() });
      setSignalementEnvoye(true);
      setSignalerOuvert(false);
    } catch (err) {
      setErreurSignalement(detailServeur(err) ?? t("Le signalement n'a pas pu être envoyé — réessaie."));
    } finally {
      setEnvoi(false);
    }
  }

  const bouton = "inline-flex min-h-[44px] items-center gap-2 rounded-full border border-ink-soft/25 px-4 text-sm font-medium hover:bg-highlight-soft disabled:opacity-60";

  if (erreur) {
    return (
      <section className="mx-auto max-w-2xl space-y-3">
        <Link to="/entrainement" className="inline-flex min-h-[44px] items-center gap-1 text-sm underline">
          <ArrowLeft size={16} aria-hidden="true" /> {t("Tous les exercices")}
        </Link>
        <div role="alert" className="rounded-lg border border-correction/30 bg-correction-soft p-5 text-sm text-correction">
          <p>{t("Cet exercice est introuvable ou momentanément indisponible.")}</p>
          <button type="button" onClick={() => setEssai((n) => n + 1)} className="mt-2 min-h-[44px] underline">
            {t("Réessayer")}
          </button>
        </div>
      </section>
    );
  }
  if (!variante) {
    return (
      <p role="status" className="mx-auto flex max-w-2xl items-center gap-2 text-sm text-ink-soft">
        <Spinner /> {t("Chargement de l'exercice.")}
      </p>
    );
  }

  return (
    <article className="mx-auto max-w-2xl space-y-5">
      <Link to="/entrainement" className="inline-flex min-h-[44px] items-center gap-1 text-sm underline">
        <ArrowLeft size={16} aria-hidden="true" /> {t("Tous les exercices")}
      </Link>
      <header>
        <h1 ref={titreRef} tabIndex={-1} className="font-serif-brand text-2xl outline-none">
          {variante.titre}
        </h1>
        <p className="mt-1 font-mono-tag text-[10px] text-slate">
          {t("Variante n° {graine}", { graine: variante.graine })} · {t("Total : {n} points", { n: formaterPoints(variante.total_points, getLang()) })}
        </p>
      </header>

      <div className="prose-exam rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
        <MarkdownContent content={variante.enonce} variant="epreuve" />
      </div>

      <ol className="space-y-4">
        {variante.questions.map((q, i) => (
          <li key={i} className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
            <h2 className="font-mono-tag text-[11px] text-slate">
              {t("Question {n}", { n: i + 1 })} · {t("{n} pts", { n: formaterPoints(q.points, getLang()) })}
            </h2>
            <div className="prose-exam mt-1">
              <MarkdownContent content={q.enonce} variant="epreuve" />
            </div>
            {correctionAffichee && correction?.corrections[i] && (
              <div className="mt-3 space-y-2 border-t border-ink-soft/10 pt-3">
                <h3 className="font-mono-tag text-[10px] text-valide">{t("Réponse")}</h3>
                <div className="prose-exam">
                  <MarkdownContent content={correction.corrections[i].reponse} variant="epreuve" />
                </div>
                <h3 className="font-mono-tag text-[10px] text-slate">{t("Méthode")}</h3>
                <div className="prose-exam">
                  <MarkdownContent content={correction.corrections[i].etapes} variant="epreuve" />
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void basculerCorrection()} aria-pressed={correctionAffichee} disabled={correctionChargement} className={`${bouton} bg-ink text-paper hover:bg-ink`}>
          {correctionChargement ? <Spinner /> : <Check size={16} strokeWidth={1.75} aria-hidden="true" />}
          {t(correctionAffichee ? "Masquer la correction" : "Voir la correction")}
        </button>
        <button type="button" onClick={() => setParams({ g: id, graine: String(graineAleatoire()) })} className={bouton}>
          <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
          {t("Autre exercice")}
        </button>
        <button type="button" onClick={() => void copierLien()} className={bouton}>
          <Link2 size={16} strokeWidth={1.75} aria-hidden="true" />
          {t("Copier le lien")}
        </button>
        <button type="button" onClick={() => setSignalerOuvert((o) => !o)} aria-expanded={signalerOuvert} className={bouton}>
          {t("Signaler une erreur")}
        </button>
      </div>
      <p role="status" aria-live="polite" className="text-sm">
        {correctionChargement ? t("Chargement de la correction.") : ""}
      </p>
      {correctionErreur && (
        <p role="alert" className="text-sm text-correction">
          {t("Impossible de charger la correction.")}
        </p>
      )}
      {signalementEnvoye && (
        <p role="status" className="rounded-lg border border-valide/40 bg-valide-soft p-3 text-sm text-valide">
          {t("Merci, ton signalement a été transmis. On vérifie cette variante.")}
        </p>
      )}

      {signalerOuvert &&
        (user ? (
          <form
            className="space-y-2 rounded-lg border border-ink-soft/15 bg-paper-raised p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void envoyerSignalement();
            }}
          >
            <h2 className="font-serif-brand text-base">{t("Signaler un problème sur cet exercice")}</h2>
            <label htmlFor="signalement-message" className="block text-sm">
              {t("Décris le problème (facultatif)")}
            </label>
            <textarea
              id="signalement-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={1000}
              rows={3}
              className="w-full rounded-[2px] border border-ink-soft/25 bg-paper p-3 text-sm"
            />
            {erreurSignalement && (
              <p role="alert" className="text-sm text-correction">
                {erreurSignalement}
              </p>
            )}
            <div className="flex gap-2">
              <button type="submit" disabled={envoi} className={`${bouton} bg-ink text-paper hover:bg-ink`}>
                {envoi && <Spinner />}
                {t("Envoyer le signalement")}
              </button>
              <button type="button" onClick={() => setSignalerOuvert(false)} className={bouton}>
                {t("Annuler")}
              </button>
            </div>
          </form>
        ) : (
          <p className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4 text-sm">
            {t("Connecte-toi pour signaler une erreur.")}{" "}
            <Link to="/connexion" className="underline">
              {t("Se connecter")}
            </Link>
          </p>
        ))}
    </article>
  );
}
