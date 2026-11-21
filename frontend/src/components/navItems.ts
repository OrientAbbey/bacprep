import {
  BookOpen,
  CalendarDays,
  CreditCard,
  Home,
  NotebookPen,
  User,
  type LucideIcon,
} from "lucide-react";
import type { Cle } from "../i18n";

/**
 * Navigation principale PARTAGÉE par l'AppBar, le tiroir mobile et la barre
 * d'onglets : une seule source de vérité pour les libellés, les icônes et
 * l'ordre. Les libellés restent en français ici ; ils sont traduits au
 * rendu (`t(item.label)`) pour que le changement de langue soit immédiat.
 *
 * Vocabulaire volontairement distinct :
 * - Catalogue : épreuves et corrigés déjà publiés ;
 * - Entraînement : exercices générés à la demande (et non « Exercices »).
 */
/** Entrée de la navigation principale : route, clé de traduction, icône et correspondance exacte. */
export interface NavItem {
  to: string;
  label: Cle;
  Icon: LucideIcon;
  end?: boolean;
}

/** Liste des entrées affichées dans la barre de navigation et le tiroir mobile. */
export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Accueil", Icon: Home, end: true },
  { to: "/catalogue", label: "Catalogue", Icon: BookOpen, end: false },
  { to: "/entrainement", label: "Entraînement", Icon: NotebookPen, end: false },
  { to: "/calendrier", label: "Calendrier", Icon: CalendarDays, end: false },
  { to: "/abonnement", label: "Abonnement", Icon: CreditCard, end: false },
];

/** Onglets de la barre mobile : mêmes entrées, plus le profil (5 emplacements). */
export const BOTTOM_NAV_ITEMS: NavItem[] = [
  ...NAV_ITEMS.filter((item) => item.to !== "/abonnement"),
  { to: "/profil", label: "Profil", Icon: User, end: false },
];
