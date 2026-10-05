import { ClipboardCheck, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { dureeEnMinutes, formaterDurée } from "../lib/chronometre";
import { useToast } from "./Toast";
import { t } from "../i18n";

/**
 * Examen blanc : compte à rebours à la durée officielle, corrigé et assistant
 * masqués (le parent lit `onChange`), puis saisie de la note /20 enregistrée
 * dans l'historique (et donc dans la révision espacée). Propose aussi
 * « À revoir » : un essai sans note, repris dans les révisions du jour.
 */
export function ExamenBlanc({
  epreuveId,
  duree,
  onChange,
}: {
  epreuveId: string;
  duree?: string | null;
  onChange: (enCours: boolean) => void;
}) {
  const { showToast } = useToast();
  const total = (dureeEnMinutes(duree) ?? 180) * 60; // 3 h par défaut si la durée est inconnue
  const [phase, setPhase] = useState<"repos" | "composition" | "note">("repos");
  const [restant, setRestant] = useState(total);
  const [note, setNote] = useState("");
  const debut = useRef(0);

  useEffect(() => {
    onChange(phase === "composition");
  }, [phase, onChange]);

  useEffect(() => {
    if (phase !== "composition") return;
    const t = window.setInterval(() => setRestant((r) => r - 1), 1000);
    return () => window.clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (phase === "composition" && restant <= 0) {
      showToast(t("Temps écoulé ! Entre ta note pour enregistrer l'essai."), "success");
      setPhase("note");
    }
  }, [phase, restant, showToast]);

  const demarrer = () => {
    setRestant(total);
    debut.current = Date.now();
    setPhase("composition");
  };
  const enregistrer = (valeur: number | null) =>
    void api
      .post("/api/me/essais", {
        epreuve_id: epreuveId,
        note: valeur,
        duree_s: phase === "note" ? Math.round((Date.now() - debut.current) / 1000) : undefined,
      })
      .then(() => {
        showToast(valeur === null ? t("Ajoutée à tes révisions.") : t("Essai enregistré."), "success");
        setPhase("repos");
        setNote("");
      })
      .catch(() => showToast(t("Enregistrement impossible — réessaie."), "error"));

  if (phase === "composition")
    return (
      <div role="timer" aria-label={t("Examen blanc en cours")} className="flex items-center gap-2 text-sm">
        <span className={`font-mono-tag tabular-nums ${restant < 300 ? "text-correction" : ""}`}>{formaterDurée(restant)}</span>
        <button onClick={() => setPhase("note")} className="min-h-[44px] rounded-full bg-ink px-4 text-paper">
          {t("Terminer")}
        </button>
      </div>
    );

  if (phase === "note")
    return (
      <form
        className="flex items-center gap-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          const v = Number(note.replace(",", "."));
          if (note.trim() === "" || !Number.isFinite(v) || v < 0 || v > 20) return showToast(t("Entre une note entre 0 et 20."), "error");
          enregistrer(v);
        }}
      >
        <label className="flex items-center gap-1">
          {t("Ma note")}
          <input
            autoFocus
            inputMode="decimal"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-16 rounded border border-ink-soft/30 bg-paper px-2 py-1.5"
            aria-label={t("Ma note sur 20")}
          />
          /20
        </label>
        <button type="submit" className="min-h-[44px] rounded-full bg-ink px-4 text-paper">
          {t("Enregistrer")}
        </button>
        <button type="button" onClick={() => setPhase("repos")} className="min-h-[44px] px-2 text-ink-soft underline">
          {t("Ignorer")}
        </button>
      </form>
    );

  return (
    <div className="flex items-center gap-1">
      <button onClick={demarrer} title={t("Compte à rebours, sans corrigé ni assistant")} className="flex min-h-[44px] items-center gap-1.5 rounded-full border border-ink-soft/25 px-3 text-sm">
        <ClipboardCheck size={14} aria-hidden="true" /> Examen blanc
      </button>
      <button onClick={() => enregistrer(null)} title={t("Revenir sur cette épreuve dans quelques jours")} className="flex min-h-[44px] items-center gap-1.5 rounded-full border border-ink-soft/25 px-3 text-sm">
        <RotateCcw size={14} aria-hidden="true" /> {t("À revoir")}
      </button>
    </div>
  );
}
