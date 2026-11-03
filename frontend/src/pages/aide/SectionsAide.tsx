export interface SectionAide {
  id: string;
  titre: string;
  intro?: string;
  points?: string[];
  astuce?: string;
}

/** Sommaire cliquable puis sections de l'aide (titre, introduction, liste de points, astuce). */
export function SectionsAide({ sections, sommaire, libelleAstuce }: { sections: SectionAide[]; sommaire: string; libelleAstuce: string }) {
  return (
    <>
      <nav aria-label={sommaire} className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
        <p className="font-mono-tag text-[10px] uppercase tracking-wide text-ink-soft">{sommaire}</p>
        <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="flex min-h-[44px] items-center text-highlight-text underline-offset-2 hover:underline sm:min-h-[32px]">
                {s.titre}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {sections.map((s) => (
        <section key={s.id} id={s.id} aria-labelledby={`${s.id}-titre`} className="scroll-mt-20">
          <h2 id={`${s.id}-titre`} className="font-serif-brand text-xl">
            {s.titre}
          </h2>
          {s.intro && <p className="mt-1 text-sm text-ink-soft">{s.intro}</p>}
          {s.points && (
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed">
              {s.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {s.astuce && (
            <p className="mt-3 rounded-lg bg-highlight-soft px-3 py-2 text-sm">
              <strong>{libelleAstuce} : </strong>
              {s.astuce}
            </p>
          )}
        </section>
      ))}
    </>
  );
}
