import { Link } from "react-router-dom";
import { t } from "../i18n";

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <p className="font-mono-tag text-xs text-slate">404</p>
      <h1 className="font-serif-brand mt-2 text-2xl">{t("Page introuvable")}</h1>
      <p className="mt-2 text-sm text-ink-soft">{t("Cette page n'existe pas ou a été déplacée.")}</p>
      <Link to="/" className="mt-6 inline-flex min-h-[44px] items-center rounded-full bg-ink px-5 text-sm text-paper">
        {t("Retour à l'accueil")}
      </Link>
    </div>
  );
}
