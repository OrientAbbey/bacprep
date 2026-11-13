import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { t } from "../i18n";
import { sectionsAideUtilisateur } from "./aide/AideUtilisateur";
import { SectionsAide } from "./aide/SectionsAide";

/**
 * Aide des élèves, dans la langue de l'interface.
 *
 * L'aide de la console a sa propre page (`/aide/admin`, sous `RequireAdmin`) :
 * un administrateur est renvoyé vers elle par un lien, plutôt que de voir deux
 * contenus différents défiler sous la même adresse.
 */
export function AidePage() {
  const { user } = useAuth();
  const estAdmin = !!user?.is_admin;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="font-serif-brand text-3xl">{t("Aide")}</h1>
        <p className="mt-1 text-sm text-ink-soft">{t("Trouve ici comment utiliser Copies & Corrigés, fonction par fonction.")}</p>
        {estAdmin && (
          <p className="mt-4 text-sm">
            <Link to="/aide/admin" className="flex min-h-[44px] items-center underline underline-offset-2">
              {t("Aide administrateur")}
            </Link>
          </p>
        )}
      </header>
      <SectionsAide sections={sectionsAideUtilisateur()} sommaire={t("Sommaire")} libelleAstuce={t("Astuce")} />
    </div>
  );
}
