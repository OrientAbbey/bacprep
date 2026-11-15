import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { sectionsAideAdmin } from "./AideAdmin";
import { SectionsAide } from "./SectionsAide";

/**
 * Guide de la console, réservé aux administrateurs : route `/aide/admin` sous
 * `RequireAdmin`, chargée à la demande (les élèves ne la téléchargent pas).
 * Français uniquement, comme la console elle-même : aucun appel à `t()`.
 */
export function AdminHelpPage() {
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      {/* Retour en DÉBUT de page : sur un guide long, l'unique lien de retour
          en bas obligeait à faire défiler tout le document pour ressortir. */}
      <nav aria-label="Retour au back-office">
        <Link
          to="/admin"
          className="inline-flex min-h-[44px] items-center gap-1 text-sm underline underline-offset-2"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          Retour au back-office
        </Link>
      </nav>
      <header>
        <h1 className="font-serif-brand text-3xl">Aide de la console d'administration</h1>
        <p className="mt-1 text-sm text-ink-soft">Ce que fait chaque onglet de la console, et les bons réflexes.</p>
      </header>
      <SectionsAide sections={sectionsAideAdmin} sommaire="Sommaire" libelleAstuce="Astuce" />
      <nav aria-label="Autres aides" className="flex flex-wrap gap-x-4 gap-y-1 border-t border-ink-soft/15 pt-4 text-sm">
        <Link to="/admin" className="flex min-h-[44px] items-center underline">
          Retour au back-office
        </Link>
        <Link to="/aide?vue=utilisateur" className="flex min-h-[44px] items-center underline">
          Aide des élèves
        </Link>
      </nav>
    </article>
  );
}
