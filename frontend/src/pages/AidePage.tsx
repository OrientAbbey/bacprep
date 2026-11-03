import { useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { t } from "../i18n";
import { sectionsAideAdmin } from "./aide/AideAdmin";
import { sectionsAideUtilisateur } from "./aide/AideUtilisateur";
import { SectionsAide } from "./aide/SectionsAide";

/** Aide de l'application. Un administrateur voit l'aide de la console ; un clic lui montre aussi celle des élèves. */
export function AidePage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const estAdmin = !!user?.is_admin;
  const vueAdmin = estAdmin && params.get("vue") !== "utilisateur";

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="font-serif-brand text-3xl">{vueAdmin ? "Aide de la console d'administration" : t("Aide")}</h1>
        <p className="mt-1 text-sm text-ink-soft">
          {vueAdmin ? "Ce que fait chaque onglet de la console, et les bons réflexes." : t("Trouve ici comment utiliser Copies & Corrigés, fonction par fonction.")}
        </p>
        {estAdmin && (
          <div role="group" aria-label={t("Aide")} className="mt-4 inline-flex overflow-hidden rounded-full border border-ink-soft/25 text-sm">
            <button
              type="button"
              aria-pressed={vueAdmin}
              onClick={() => setParams({})}
              className={`min-h-[44px] px-4 ${vueAdmin ? "bg-ink text-paper" : "text-ink-soft hover:bg-highlight-soft"}`}
            >
              {t("Aide administrateur")}
            </button>
            <button
              type="button"
              aria-pressed={!vueAdmin}
              onClick={() => setParams({ vue: "utilisateur" })}
              className={`min-h-[44px] px-4 ${vueAdmin ? "text-ink-soft hover:bg-highlight-soft" : "bg-ink text-paper"}`}
            >
              {t("Aide utilisateur")}
            </button>
          </div>
        )}
      </header>
      {vueAdmin ? (
        <SectionsAide sections={sectionsAideAdmin} sommaire="Sommaire" libelleAstuce="Astuce" />
      ) : (
        <SectionsAide sections={sectionsAideUtilisateur()} sommaire={t("Sommaire")} libelleAstuce={t("Astuce")} />
      )}
    </div>
  );
}
