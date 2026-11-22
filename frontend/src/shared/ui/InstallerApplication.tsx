import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { estDejaInstallee, peutProposerInstallation } from "../lib/installation";

/** Événement Chromium différé par `beforeinstallprompt` : il doit être gardé
 * sous la main jusqu'au clic, sinon le navigateur refuse de l'afficher. */
interface EvenementInstallation extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const CLE_REFUS = "bacprep_install_refus";

/** Bouton « Installer l'application » affiché uniquement quand le navigateur
 * propose réellement l'installation (Chrome/Android/ordinateur). Sur iOS, où
 * cet événement n'existe pas, le guide de l'aide donne la marche à suivre avec
 * Safari. Un refus est mémorisé 30 jours pour ne pas harceler l'élève. */
export function InstallerApplication() {
  const [evenement, setEvenement] = useState<EvenementInstallation | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (estDejaInstallee()) return;
    let refuse: string | null = null;
    try {
      refuse = localStorage.getItem(CLE_REFUS);
    } catch {
      // Stockage indisponible (navigation privée) : on propose quand même.
    }
    if (!peutProposerInstallation(refuse)) return;

    const surProposition = (e: Event) => {
      e.preventDefault();
      setEvenement(e as EvenementInstallation);
      setVisible(true);
    };
    const surInstallation = () => {
      setVisible(false);
      setEvenement(null);
      try {
        localStorage.removeItem(CLE_REFUS);
      } catch {
        // Rien à nettoyer si le stockage est indisponible.
      }
    };
    window.addEventListener("beforeinstallprompt", surProposition);
    window.addEventListener("appinstalled", surInstallation);
    return () => {
      window.removeEventListener("beforeinstallprompt", surProposition);
      window.removeEventListener("appinstalled", surInstallation);
    };
  }, []);

  if (!visible || !evenement) return null;

  const installer = async () => {
    await evenement.prompt();
    const choix = await evenement.userChoice;
    if (choix.outcome === "accepted") {
      setVisible(false);
      setEvenement(null);
    } else {
      mémoriserRefus();
      setVisible(false);
      setEvenement(null);
    }
  };

  const plusTard = () => {
    mémoriserRefus();
    setVisible(false);
    setEvenement(null);
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-ink-soft/15 bg-paper-raised px-3 py-2">
      <p className="min-w-0 flex-1 text-sm">{t("Tu peux installer l'application sur ton écran d'accueil pour un accès rapide, même hors-ligne.")}</p>
      <button
        type="button"
        onClick={installer}
        className="min-h-[36px] rounded-md bg-highlight px-3 text-sm font-medium text-paper hover:opacity-90"
      >
        {t("Installer l'application")}
      </button>
      <button
        type="button"
        onClick={plusTard}
        className="min-h-[36px] rounded-md px-3 text-sm text-ink-soft underline underline-offset-2 hover:text-ink"
      >
        {t("Plus tard")}
      </button>
    </div>
  );
}

function mémoriserRefus(): void {
  try {
    localStorage.setItem(CLE_REFUS, new Date().toISOString());
  } catch {
    // Stockage indisponible : la proposition reviendra au prochain chargement.
  }
}
