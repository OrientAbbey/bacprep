import { BookOpen, CalendarDays, Home, User } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { t } from "../i18n";

const ONGLETS = [
  { to: "/", label: t("Accueil"), Icon: Home, end: true },
  { to: "/catalogue", label: t("Catalogue"), Icon: BookOpen, end: false },
  { to: "/calendrier", label: t("Calendrier"), Icon: CalendarDays, end: false },
  { to: "/profil", label: t("Profil"), Icon: User, end: false },
];

/** Barre d'onglets en bas de l'écran, mobile uniquement (pouce). Masquée dans
 * l'admin et dans le lecteur, qui occupent tout l'écran. */
export function BottomNav() {
  const { pathname } = useLocation();
  if (pathname.startsWith("/admin") || pathname.startsWith("/epreuve/")) return null;
  return (
    <nav
      aria-label={t("Navigation principale")}
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-ink-soft/15 bg-paper-raised pb-[env(safe-area-inset-bottom)] sm:hidden"
    >
      {ONGLETS.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${
              isActive ? "text-highlight-text" : "text-ink-soft"
            }`
          }
        >
          <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
