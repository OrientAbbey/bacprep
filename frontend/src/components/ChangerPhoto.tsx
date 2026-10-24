import { Camera, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { api } from "../api/client";
import { t } from "../i18n";
import { messageEnvoiPhoto, messagePhoto, refusPhoto } from "../lib/avatar";
import { useToast } from "./Toast";

const BOUTON = "flex min-h-[44px] items-center gap-1.5 rounded-full border border-ink-soft/25 px-3 text-xs text-ink-soft hover:border-highlight/50 disabled:opacity-50";

/** Envoi de la photo de profil (avec aperçu avant d'enregistrer) et retrait. `onChange` recharge l'utilisateur. */
export function ChangerPhoto({ avecPhoto, onChange }: { avecPhoto: boolean; onChange: () => Promise<unknown> }) {
  const { showToast } = useToast();
  const champ = useRef<HTMLInputElement>(null);
  const [fichier, setFichier] = useState<File | null>(null);
  const [apercu, setApercu] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  useEffect(() => {
    if (!fichier) {
      setApercu(null);
      return;
    }
    const url = URL.createObjectURL(fichier);
    setApercu(url);
    return () => URL.revokeObjectURL(url);
  }, [fichier]);

  function choisir(e: ChangeEvent<HTMLInputElement>) {
    const choisi = e.target.files?.[0];
    e.target.value = ""; // permet de rechoisir le même fichier
    if (!choisi) return;
    const refus = refusPhoto(choisi);
    setErreur(refus);
    setFichier(refus ? null : choisi);
  }

  async function agir(action: () => Promise<unknown>, succes: string, echec: (e: unknown) => string) {
    setEnCours(true);
    setErreur(null);
    try {
      await action();
      await onChange();
      setFichier(null);
      showToast(succes, "success");
    } catch (err) {
      setErreur(echec(err));
    } finally {
      setEnCours(false);
    }
  }

  const envoyer = () => {
    const corps = new FormData();
    corps.append("file", fichier!);
    return agir(() => api.upload("/api/me/avatar", corps), t("Photo de profil mise à jour."), messageEnvoiPhoto);
  };
  const retirer = () => agir(() => api.del("/api/me/avatar"), t("Photo de profil retirée."), () => t("Le retrait de la photo a échoué — réessaie."));

  return (
    <div className="mt-3">
      <input ref={champ} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={choisir} className="hidden" aria-label={t("Choisir une photo")} />
      {apercu ? (
        <div className="flex items-center gap-3">
          <img
            src={apercu}
            alt={t("Aperçu de la nouvelle photo")}
            onError={() => {
              setErreur(messagePhoto(415));
              setFichier(null);
            }}
            className="h-16 w-16 shrink-0 rounded-full object-cover"
          />
          <div className="flex flex-col items-start gap-2">
            <button type="button" onClick={envoyer} disabled={enCours} className="min-h-[44px] whitespace-nowrap rounded-full bg-ink px-3 text-sm font-medium text-paper disabled:opacity-50">
              {enCours ? t("Envoi…") : t("Enregistrer la photo")}
            </button>
            <button type="button" onClick={() => setFichier(null)} disabled={enCours} className="min-h-[44px] rounded-full border border-ink-soft/25 px-3 text-sm text-ink-soft disabled:opacity-50">
              {t("Annuler")}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => champ.current?.click()} disabled={enCours} className={BOUTON}>
            <Camera size={12} strokeWidth={1.75} aria-hidden="true" />
            {avecPhoto ? t("Changer la photo") : t("Ajouter une photo")}
          </button>
          {avecPhoto && (
            <button type="button" onClick={retirer} disabled={enCours} className={BOUTON}>
              <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
              {t("Retirer la photo")}
            </button>
          )}
        </div>
      )}
      {erreur && (
        <p role="alert" className="mt-2 text-xs text-correction">
          {erreur}
        </p>
      )}
    </div>
  );
}
