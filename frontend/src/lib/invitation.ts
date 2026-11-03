import { t } from "../i18n";

/** Message d'invitation (texte seul : le lien est ajouté par chaque application de partage). */
export const texteInvitation = () =>
  t("Je prépare mes examens avec Copies & Corrigés : les épreuves et corrigés du secondaire camerounais, avec un tuteur IA. Rejoins-moi !");

/** Adresse du site à partager : la racine, quel que soit l'écran où se trouve l'élève. */
export const urlSite = (origine: string) => `${origine}/`;

export interface LienPartage {
  id: "whatsapp" | "facebook" | "telegram" | "email";
  label: string;
  href: string;
}

/** Liens de partage directs : s'ouvrent dans l'application installée (WhatsApp, Telegram…) ou son site web. */
export function liensPartage(url: string, texte: string): LienPartage[] {
  const u = encodeURIComponent(url);
  const message = encodeURIComponent(`${texte} ${url}`);
  return [
    { id: "whatsapp", label: "WhatsApp", href: `https://wa.me/?text=${message}` },
    { id: "facebook", label: "Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${u}` },
    { id: "telegram", label: "Telegram", href: `https://t.me/share/url?url=${u}&text=${encodeURIComponent(texte)}` },
    { id: "email", label: t("E-mail"), href: `mailto:?subject=${encodeURIComponent(t("Invitation à rejoindre Copies & Corrigés"))}&body=${message}` },
  ];
}

/** Feuille de partage du système (mobile surtout) : toutes les applications installées, pas seulement les quatre ci-dessus. */
export const partageNatifDisponible = () => typeof navigator !== "undefined" && typeof navigator.share === "function";
