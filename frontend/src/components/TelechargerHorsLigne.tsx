import { CloudDownload, CloudOff, Loader2 } from "lucide-react";
import { useState } from "react";
import { estTelechargee, horsLigneDisponible, retirer, telecharger } from "../lib/horsLigne";
import { t } from "../i18n";
import { useToast } from "./Toast";

/** Bouton du lecteur : garde l'épreuve (texte + images) sur l'appareil pour la lire sans connexion. */
export function TelechargerHorsLigne({ id, matiere, annee, evaluation }: { id: string; matiere: string; annee: string; evaluation: string }) {
  const { showToast } = useToast();
  const [present, setPresent] = useState(() => estTelechargee(id));
  const [encours, setEncours] = useState(false);
  if (!horsLigneDisponible()) return null;

  const basculer = async () => {
    setEncours(true);
    try {
      if (present) {
        await retirer(id);
        setPresent(false);
        showToast(t("Copie hors-ligne supprimée."), "success");
      } else {
        await telecharger({ id, matiere, annee, evaluation });
        setPresent(true);
        showToast(t("Épreuve disponible hors-ligne."), "success");
      }
    } catch {
      showToast(t("Téléchargement impossible — vérifie ta connexion."), "error");
    } finally {
      setEncours(false);
    }
  };

  return (
    <button
      type="button"
      onClick={basculer}
      disabled={encours}
      aria-pressed={present}
      title={present ? t("Disponible hors-ligne — cliquer pour supprimer la copie") : t("Télécharger pour lire sans connexion")}
      className="flex min-h-[44px] items-center gap-1.5 rounded-full border border-ink-soft/25 px-3 text-sm disabled:opacity-60"
    >
      {encours ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : present ? <CloudOff size={14} aria-hidden="true" /> : <CloudDownload size={14} aria-hidden="true" />}
      {present ? t("Hors-ligne ✓") : t("Hors-ligne")}
    </button>
  );
}
