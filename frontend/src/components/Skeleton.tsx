/** Squelette de chargement — bloc gris neutre pulsant (classe .skeleton
 * définie dans index.css, désactivée si prefers-reduced-motion). Utiliser
 * avec des dimensions explicites (w-/h-) pour imiter la forme du contenu
 * réel en cours de chargement. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}

/** Grille de squelettes imitant les cartes du catalogue. */
export function CatalogueSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
        </div>
      ))}
    </div>
  );
}

/** Squelette du lecteur d'épreuve : ligne de titre + métadonnées + bloc
 * de lecture. */
export function ViewerSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-9 w-44 rounded-full" />
      </div>
      <Skeleton className="h-3 w-2/3" />
      <div className="space-y-2 rounded-lg border border-ink-soft/15 bg-paper-raised p-6">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className={`h-3 ${i % 3 === 2 ? "w-2/3" : "w-full"}`} />
        ))}
      </div>
    </div>
  );
}
