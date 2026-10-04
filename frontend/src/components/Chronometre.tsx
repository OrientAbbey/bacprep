import { Pause, Play, RotateCcw, Timer, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { dureeEnMinutes, formaterDurée } from "../lib/chronometre";
import { useToast } from "./Toast";
import { t } from "../i18n";

/**
 * Chronomètre de traitement d'une épreuve, pliable dans l'en-tête du lecteur.
 * Activable/désactivable : l'élève définit la durée (pré-remplie par la durée
 * officielle de l'épreuve si dispo) puis lance un compte à rebours. À zéro :
 * signal visuel (rouge clignotant) + notification. La fenêtre est fermée à la
 * main ; le compte continue en arrière-plan tant qu'il est lancé.
 */
export function Chronometre({ dureeEpreuve }: { dureeEpreuve?: string | null }) {
  const { showToast } = useToast();
  const [panneauOuvert, setPanneauOuvert] = useState(false);
  const [minutes, setMinutes] = useState("");
  const [restant, setRestant] = useState<number | null>(null); // secondes
  const [tourne, setTourne] = useState(false);
  const [expire, setExpire] = useState(false);
  const intervalRef = useRef<number | null>(null);

  // Durée saisie : au premier agrandissement, on pré-remplit avec la durée de
  // l'épreuve si elle est lisible.
  useEffect(() => {
    if (panneauOuvert && !minutes && restant === null) {
      const depuisEpreuve = dureeEnMinutes(dureeEpreuve);
      if (depuisEpreuve !== null) setMinutes(String(depuisEpreuve));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panneauOuvert]);

  const stopCount = useCallback(() => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => stopCount, [stopCount]);

  function demarrer() {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m <= 0) {
      showToast(t("Saisis un temps en minutes pour lancer le chronomètre."), "error");
      return;
    }
    stopCount();
    // Démarrage à NEUF (restant === null) : partir de la durée saisie.
    // REPRISE après pause : garder le `restant` courant — la version
    // précédente réinitialisait toujours le compte depuis le début, le
    // bouton « Reprendre » repartant à la durée initiale (revue 2026-09,
    // REVUE_FRONTEND.md F8).
    if (restant === null) {
      setRestant(Math.round(m * 60));
    }
    setTourne(true);
    setExpire(false);
    intervalRef.current = window.setInterval(() => {
      setRestant((sec) => {
        if (sec === null || sec <= 1) {
          if (sec !== null) setExpire(true);
          setTourne(false);
          stopCount();
          return 0;
        }
        return sec - 1;
      });
    }, 1000);
  }

  useEffect(() => {
    if (expire) {
      const t = window.setTimeout(() => setExpire(false), 6000);
      return () => window.clearTimeout(t);
    }
  }, [expire]);

  function relancer() {
    stopCount();
    setTourne(false);
    setRestant(null);
    setExpire(false);
    setMinutes("");
  }

  function fermer() {
    setPanneauOuvert(false);
    stopCount();
    setTourne(false);
  }

  const minutesTotal = minutes === "" ? 0 : Number(minutes);
  const valide = Number.isFinite(minutesTotal) && minutesTotal > 0;

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setPanneauOuvert((o) => !o);
          if (tourne && restant !== null) setExpire(false);
        }}
        title={restant !== null ? t("Temps restant : {t}", { t: formaterDurée(restant) }) : t("Chronomètre de traitement")}
        aria-label={
          restant !== null
            ? t("Chronomètre, temps restant {t}", { t: formaterDurée(restant) })
            : t("Chronomètre de traitement du sujet")
        }
        aria-expanded={panneauOuvert}
        aria-haspopup="dialog"
        className={`flex min-h-[44px] items-center gap-1.5 rounded-full px-3 text-sm transition-colors ${
          restant !== null
            ? expire
              ? "bg-correction-soft text-correction ring-2 ring-correction"
              : "bg-ink text-paper"
            : "border border-ink-soft/20 text-ink-soft hover:border-highlight/50 hover:bg-highlight-soft/40"
        }`}
      >
        <Timer size={15} strokeWidth={1.75} aria-hidden="true" />
        {restant !== null ? formaterDurée(restant) : "Chrono"}
      </button>

      {panneauOuvert && (
        <div
          role="dialog"
          aria-label={t("Chronomètre de traitement")}
          className="absolute right-0 z-30 mt-2 w-64 rounded-lg border border-ink-soft/15 bg-paper-raised p-4 shadow-lg"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-serif-brand text-sm">{t("Chronomètre")}</p>
            <button
              type="button"
              onClick={fermer}
              aria-label={t("Fermer le chronomètre")}
              className="rounded p-1 text-slate hover:bg-highlight-soft/40 hover:text-ink"
            >
              <X size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>

          {restant === null ? (
            <>
              <label htmlFor="chrono-minutes" className="mt-3 block font-mono-tag text-[10px] text-ink-soft">
                {t("Temps pour traiter ce sujet (minutes)")}
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="chrono-minutes"
                  type="number"
                  min={1}
                  max={24 * 60}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                  placeholder={t("ex. 180")}
                  className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper px-3 text-sm"
                />
                <button
                  type="button"
                  onClick={demarrer}
                  disabled={!valide}
                  title={t("Lancer le compte à rebours")}
                  aria-label={t("Lancer le compte à rebours")}
                  className="flex min-h-[44px] items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-medium text-paper hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Play size={14} strokeWidth={1.75} aria-hidden="true" />
                  {t("Démarrer")}
                </button>
              </div>
              <p className="mt-2 font-mono-tag text-[10px] text-slate">
                {t("À zéro, le chrono passe au rouge et une notification apparaît.")}
              </p>
            </>
          ) : (
            <>
              <p
                role="status"
                aria-live="polite"
                className={`mt-3 text-center font-mono-tag text-3xl tracking-tight ${
                  expire ? "animate-pulse text-correction" : "text-ink"
                }`}
              >
                {formaterDurée(restant)}
              </p>
              {expire && <p className="mt-1 text-center text-sm text-correction">{t("Temps écoulé !")}</p>}
              <div className="mt-3 flex justify-center gap-2">
                {tourne ? (
                  <button
                    type="button"
                    onClick={() => {
                      stopCount();
                      setTourne(false);
                    }}
                    className="flex min-h-[44px] items-center gap-1.5 rounded-full border border-ink-soft/25 px-4 text-sm text-ink hover:bg-highlight-soft/40"
                  >
                    <Pause size={14} strokeWidth={1.75} aria-hidden="true" />
                    {t("Pause")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={demarrer}
                    disabled={restant <= 0}
                    className="flex min-h-[44px] items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-medium text-paper hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Play size={14} strokeWidth={1.75} aria-hidden="true" />
                    {t("Reprendre")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={relancer}
                  className="flex min-h-[44px] items-center gap-1.5 rounded-full border border-ink-soft/25 px-4 text-sm text-ink hover:bg-highlight-soft/40"
                >
                  <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
                  {t("Réinitialiser")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}