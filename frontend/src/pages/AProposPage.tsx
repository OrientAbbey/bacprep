import { Link } from "react-router-dom";
import { BoutonInviter } from "../components/Invitation";
import { t } from "../i18n";

/** Adresse de contact affichée si elle est fournie à la compilation (`VITE_CONTACT_EMAIL`) ; sinon rien n'est affiché. */
const CONTACT = import.meta.env.VITE_CONTACT_EMAIL as string | undefined;

export function AProposPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="font-serif-brand text-3xl">{t("À propos de Copies & Corrigés")}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          {t("Copies & Corrigés est une application web pour les élèves du secondaire camerounais, de la 6e à la Terminale : des épreuves et leurs corrigés, un tuteur IA pour comprendre, et des outils de révision.")}
        </p>
      </header>
      <section aria-labelledby="a-propos-contenu">
        <h2 id="a-propos-contenu" className="font-serif-brand text-xl">
          {t("Ce que tu y trouves")}
        </h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed">
          <li>{t("Les épreuves et corrigés du BAC et d'autres évaluations, classés par classe, matière, année et série.")}</li>
          <li>{t("Un lecteur confortable : feuille A4, taille du texte réglable, mode immersion, lecture hors-ligne.")}</li>
          <li>{t("Le Tuteur IA, les notes personnelles, le chronomètre, l'examen blanc et la révision espacée.")}</li>
          <li>{t("Le calendrier officiel des examens, en français et en anglais.")}</li>
        </ul>
      </section>
      <section aria-labelledby="a-propos-principes">
        <h2 id="a-propos-principes" className="font-serif-brand text-xl">
          {t("Nos principes")}
        </h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed">
          <li>{t("Ta vie privée : tes conversations avec le Tuteur IA et tes notes ne sont conservées que si tu l'acceptes, et tu peux changer d'avis à tout moment.")}</li>
          <li>{t("Des contenus relus : une épreuve n'est publiée qu'après relecture par l'équipe, et chacun peut signaler une erreur.")}</li>
          <li>{t("Pensée pour le téléphone : application installable, lecture hors-ligne, thème sombre, deux langues.")}</li>
          <li>{t("L'IA peut se tromper : le Tuteur est une aide, le corrigé officiel et ton professeur restent la référence.")}</li>
        </ul>
      </section>
      <section aria-labelledby="a-propos-contact">
        <h2 id="a-propos-contact" className="font-serif-brand text-xl">
          {t("Une question, une erreur dans une épreuve ?")}
        </h2>
        <p className="mt-2 text-sm leading-relaxed">
          {t("Signale une erreur avec le drapeau du lecteur. Pour ton compte et tes données, ouvre ton profil. Tu trouveras aussi la réponse à beaucoup de questions dans l'aide.")}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link to="/aide" className="flex min-h-[44px] items-center rounded-full bg-ink px-5 text-sm font-medium text-paper">
            {t("Ouvrir l'aide")}
          </Link>
          <BoutonInviter variante="lien" className="min-h-[44px] rounded-full border border-ink-soft/25 px-5 text-sm hover:bg-highlight-soft" />
          {CONTACT && (
            <a href={`mailto:${CONTACT}`} className="flex min-h-[44px] items-center rounded-full border border-ink-soft/25 px-5 text-sm hover:bg-highlight-soft">
              {t("Nous écrire")}
            </a>
          )}
        </div>
      </section>
    </div>
  );
}
