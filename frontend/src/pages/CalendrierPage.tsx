import { CalendarDays, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Evenement } from "../api/types";
import { Skeleton } from "../components/Skeleton";
import { formaterDate, joursAvant } from "../lib/calendrier";
import { t } from "../i18n";

const TYPES: Record<Evenement["type"], string> = { examen: t("Examen"), resultats: t("Résultats"), inscription: t("Inscription") };

/** Calendrier officiel des examens et résultats (dates saisies par l'admin). */
export function CalendrierPage() {
  const [evenements, setEvenements] = useState<Evenement[] | null>(null);
  const [erreur, setErreur] = useState(false);
  useEffect(() => {
    api.get<Evenement[]>("/api/calendrier").then(setEvenements).catch(() => setErreur(true));
  }, []);

  const aVenir = evenements?.filter((e) => joursAvant(e.date_fin || e.date_debut) >= 0) ?? [];
  const passes = evenements?.filter((e) => joursAvant(e.date_fin || e.date_debut) < 0).reverse() ?? [];

  const ligne = (e: Evenement) => {
    const j = joursAvant(e.date_debut);
    return (
      <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
        <span className="font-mono-tag w-24 text-[11px] text-slate">{TYPES[e.type].toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <p className="font-serif-brand text-base">{e.titre}</p>
          <p className="text-xs text-ink-soft">
            {formaterDate(e.date_debut)}
            {e.date_fin && e.date_fin !== e.date_debut ? ` → ${formaterDate(e.date_fin)}` : ""}
            {e.evaluation ? ` · ${e.evaluation}` : ""}
          </p>
        </div>
        {j > 0 && <span className="font-mono-tag text-xs text-highlight-text">J−{j}</span>}
        {j === 0 && <span className="font-mono-tag text-xs text-highlight-text">{t("Aujourd'hui")}</span>}
        {e.lien_officiel && (
          <a href={e.lien_officiel} target="_blank" rel="noopener noreferrer" className="flex min-h-[44px] items-center gap-1 text-xs underline">
            Site officiel <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </li>
    );
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="font-serif-brand flex items-center gap-2 text-2xl">
          <CalendarDays size={22} aria-hidden="true" /> {t("Calendrier et résultats")}
        </h1>
        <p className="text-sm text-ink-soft">{t("Dates des examens et des résultats. Les résultats se consultent sur les canaux officiels.")}</p>
      </header>
      {erreur && <p role="alert" className="text-sm text-correction">{t("Le calendrier n'a pas pu être chargé.")}</p>}
      {!evenements && !erreur && <Skeleton className="h-40 w-full" />}
      {evenements && evenements.length === 0 && <p className="text-sm text-slate">{t("Aucune date publiée pour le moment.")}</p>}
      {aVenir.length > 0 && (
        <section aria-label={t("À venir")} className="space-y-2">
          <h2 className="font-mono-tag text-xs text-ink-soft">{t("À VENIR")}</h2>
          <ul className="space-y-2">{aVenir.map(ligne)}</ul>
        </section>
      )}
      {passes.length > 0 && (
        <section aria-label={t("Passés")} className="space-y-2">
          <h2 className="font-mono-tag text-xs text-ink-soft">{t("PASSÉS")}</h2>
          <ul className="space-y-2 opacity-75">{passes.map(ligne)}</ul>
        </section>
      )}
    </div>
  );
}
