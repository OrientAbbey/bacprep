import { ArrowLeft, Check, Link2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { MarkdownContent } from "../components/MarkdownContent";
import { Spinner } from "../components/Spinner";
import { useToast } from "../components/Toast";
import { getLang, t } from "../i18n";
import { detailServeur } from "../lib/detailServeur";
import {
  type CorrectionVariante,
  type ResumeGabarit,
  type Variante,
  formaterPoints,
  graineAleatoire,
  graineDepuisUrl,
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
export function EntrainementPage() {
  const [params] = useSearchParams();
  const id = params.get("g");
  return id ? <Exercice key={id} id={id} /> : <Liste />;
}

function Liste() {
  const [liste, setListe] = useState<ResumeGabarit[] | null>(null);
  const [erreur, setErreur] = useState(false);
  const [essai, setEssai] = useState(0);

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

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="font-serif-brand text-2xl">{t("Entraînement")}</h1>
        <p className="mt-2 text-sm text-ink-soft">
          {t("Des exercices à refaire autant de fois que tu veux : à chaque fois, les valeurs changent. Cherche d'abord sur ta feuille, puis affiche la correction détaillée.")}
        </p>
      </header>

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
      {liste &&
        regrouper(liste).map((m) => (
          <section key={m.matiere} aria-labelledby={`mat-${m.matiere}`} className="space-y-3">
            <h2 id={`mat-${m.matiere}`} className="font-serif-brand text-xl">
              {m.matiere}
            </h2>
            {m.chapitres.map((c) => (
              <div key={c.chapitre} className="space-y-2">
                <h3 className="font-mono-tag text-[11px] text-slate">{c.chapitre}</h3>
                <ul className="space-y-2">
                  {c.exercices.map((ex) => (
                    <li key={ex.id} className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
                      <p className="font-medium">{ex.titre}</p>
                      <p className="mt-1 text-xs text-ink-soft">
                        {t("Difficulté {n} sur 3", { n: ex.difficulte })} · {t("Classes : {liste}", { liste: ex.classes.map(classeLabel).join(", ") })}
                      </p>
                      <Link
                        to={`/entrainement?g=${encodeURIComponent(ex.id)}`}
                        className="mt-3 inline-flex min-h-[44px] items-center rounded-full bg-ink px-5 text-sm font-medium text-paper"
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
