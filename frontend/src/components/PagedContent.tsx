import { ChevronLeft, ChevronRight } from "lucide-react";
import { ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import {
  actionClavier,
  ancrePourPage,
  bornerPage,
  dimensionsFeuille,
  directionBalayage,
  ECART_PAGES,
  ElementPage,
  finDernierePage,
  nombrePages,
  pagePourAncre,
  zoneTexte,
} from "../lib/pagination";

/** Lecture page par page sur une FEUILLE A4 : on mesure la zone libre (`cadre`), `dimensionsFeuille` en tire une feuille
 *  portrait centrée (hauteur = zone, largeur = hauteur/√2) — ou une double page quand la zone peut porter deux feuilles,
 *  ou toute la largeur sur téléphone. Le contenu est mis en colonnes CSS dans la fenêtre `hote`, de taille explicite
 *  (la feuille moins ses marges) ; une page = UNE colonne, ou DEUX en double page. Tourner la page = faire défiler la
 *  fenêtre d'une page. Pas de transform : les coordonnées des sélections (SelectionBar) restent exactes.
 *
 *  - `filigrane` : rendu DANS la feuille, par-dessus le texte (la feuille est opaque : posé derrière, il serait caché) ;
 *  - `reflow` : change quand la mise en page change sans que le contenu change (taille du texte…) → on retrouve,
 *    grâce à une ancre (offset source du premier bloc de la page), la page où ce passage se trouve maintenant ;
 *  - nouveau contenu (autre sujet, corrigé…) : le parent change la `key` du composant → retour à la page 1 ;
 *  - `onPageChange` : le parent oublie par ex. la sélection en cours (elle est restée sur l'ancienne page). */
export function PagedContent({
  children,
  reflow,
  onPageChange,
  filigrane,
}: {
  children: ReactNode;
  reflow?: string | number;
  onPageChange?: (page: number) => void;
  filigrane?: ReactNode;
}) {
  const cadre = useRef<HTMLDivElement>(null);
  const hote = useRef<HTMLDivElement>(null);
  const flux = useRef<HTMLDivElement>(null);
  const [zoneLibre, setZoneLibre] = useState({ w: 0, h: 0 });
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(1);
  const [tick, setTick] = useState(0); // incrémenté quand une image ou une police finit de charger
  const pageRef = useRef(0);
  const totalRef = useRef(1);
  const ancre = useRef<number | null>(null);
  const toucher = useRef<{ x: number; y: number } | null>(null);
  const feuille = useMemo(() => dimensionsFeuille(zoneLibre.w, zoneLibre.h), [zoneLibre]);
  const colonnes = feuille.colonnes;
  // Zone de texte arrondie à l'entier : des pas de page fractionnaires dériveraient d'une page à l'autre.
  const zone = useMemo(() => {
    const z = zoneTexte(feuille);
    return { w: Math.floor(z.largeur), h: Math.floor(z.hauteur) };
  }, [feuille]);
  const dim = zone;
  const pas = dim.w + ECART_PAGES;

  /** Chaque bloc source et la page où il commence (mesure du DOM : appelée aux changements de page seulement). */
  const mesurer = useCallback((): ElementPage[] => {
    const f = flux.current;
    if (!f || dim.w <= 0) return [];
    const gauche = f.getBoundingClientRect().left;
    return Array.from(f.querySelectorAll<HTMLElement>("[data-src-start]")).flatMap((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return [];
      return [{ start: Number(el.dataset.srcStart), page: Math.floor((r.left - gauche) / pas + 0.001) }];
    });
  }, [dim.w, pas]);

  const poser = useCallback(
    (p: number) => {
      pageRef.current = p;
      setPage(p);
      if (hote.current) hote.current.scrollLeft = Math.round(p * pas);
    },
    [pas]
  );

  const aller = useCallback(
    (p: number) => {
      const cible = bornerPage(p, totalRef.current);
      if (cible === pageRef.current) return;
      poser(cible);
      ancre.current = ancrePourPage(mesurer(), cible);
      onPageChange?.(cible);
    },
    [poser, mesurer, onPageChange]
  );

  // Taille de la zone libre (redimensionnement, ouverture du tiroir de l'assistant, immersion…). On observe le CADRE,
  // jamais la feuille : sa taille ne dépend pas du contenu, donc pas de boucle de mesure.
  useEffect(() => {
    const c = cadre.current;
    if (!c) return;
    let raf = 0;
    const lire = () => {
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (w >= 1 && h >= 1) setZoneLibre((d) => (d.w === w && d.h === h ? d : { w, h }));
    };
    lire();
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(lire);
    });
    ro.observe(c);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  // Images et polices qui finissent de charger changent la hauteur du contenu, donc la pagination. On écoute le CADRE
  // (toujours monté), pas le flux : la feuille — donc le flux — n'existe qu'après la première mesure de la zone libre.
  // Les évènements `load` ne remontent pas, mais l'écoute en phase de capture les reçoit quand même.
  useEffect(() => {
    const f = cadre.current;
    const bump = () => setTick((n) => n + 1);
    f?.addEventListener("load", bump, true);
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    void fonts?.ready.then(bump);
    fonts?.addEventListener?.("loadingdone", bump);
    return () => {
      f?.removeEventListener("load", bump, true);
      fonts?.removeEventListener?.("loadingdone", bump);
    };
  }, []);

  // (Re)pagination : nombre de pages, puis retour sur le passage qu'on lisait (ancre) plutôt que sur un numéro.
  useLayoutEffect(() => {
    const h = hote.current;
    if (!h || dim.w <= 0) return;
    // On mesure le FLUX (colonnes de débordement comprises), pas la fenêtre : la cale de fin de page, posée dans la
    // fenêtre, fausserait sinon la mesure qui sert à la placer.
    const n = nombrePages(flux.current?.scrollWidth ?? h.scrollWidth, dim.w, ECART_PAGES, colonnes);
    totalRef.current = n;
    setTotal(n);
    const cible = ancre.current !== null ? pagePourAncre(mesurer(), ancre.current) : pageRef.current;
    poser(bornerPage(cible, n));
  }, [dim.w, dim.h, colonnes, reflow, tick, mesurer, poser]);

  // Défilement non voulu (recherche dans la page, focus sur un lien d'une autre page) : la page affichée suit.
  const surDefilement = () => {
    const h = hote.current;
    if (!h || dim.w <= 0) return;
    const p = bornerPage(h.scrollLeft / pas, totalRef.current);
    if (p === pageRef.current) return;
    pageRef.current = p;
    setPage(p);
    ancre.current = ancrePourPage(mesurer(), p);
    onPageChange?.(p);
  };

  const surTouche = (e: React.KeyboardEvent) => {
    const a = actionClavier(e);
    if (!a) return;
    e.preventDefault();
    aller(a === "suivante" ? pageRef.current + 1 : a === "precedente" ? pageRef.current - 1 : a === "premiere" ? 0 : totalRef.current - 1);
  };

  const surFinToucher = (e: React.TouchEvent) => {
    const debut = toucher.current;
    toucher.current = null;
    const fin = e.changedTouches[0];
    // Pas de changement de page si l'élève vient de sélectionner du texte (appui long) : ce n'est pas un balayage.
    if (!debut || !fin || !window.getSelection()?.isCollapsed) return;
    const d = directionBalayage(fin.clientX - debut.x, fin.clientY - debut.y);
    if (d) aller(pageRef.current + d);
  };

  const bouton =
    "flex min-h-[44px] items-center gap-1 rounded-full border border-ink-soft/25 px-4 text-sm text-ink hover:bg-highlight-soft disabled:opacity-35 disabled:hover:bg-transparent";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={cadre} className="relative min-h-0 flex-1">
        {feuille.largeur > 0 && (
          <div className="absolute inset-0 flex justify-center">
            <div
              data-testid="feuille"
              data-colonnes={colonnes}
              className="relative shrink-0 bg-paper-raised shadow-md ring-1 ring-ink-soft/10"
              style={{ width: feuille.largeur, height: feuille.hauteur, padding: feuille.marge }}
            >
              <div
                ref={hote}
                role="group"
                aria-label={t("Contenu de l'épreuve")}
                tabIndex={0}
                onKeyDown={surTouche}
                onScroll={surDefilement}
                onTouchStart={(e) => {
                  // Un seul doigt = début d'un balayage ; deux doigts = pincement (voir usePincementZoom), jamais un balayage.
                  toucher.current = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
                }}
                onTouchEnd={surFinToucher}
                style={{ width: dim.w, height: dim.h, touchAction: "pan-y" }}
                className="overflow-hidden"
              >
                <div className="relative" style={{ width: dim.w }}>
                  <div
                    ref={flux}
                    className="paged-flux"
                    data-colonnes={colonnes}
                    style={
                      {
                        width: dim.w,
                        height: dim.h,
                        columnCount: colonnes,
                        columnGap: ECART_PAGES,
                        columnRule: colonnes === 2 ? "1px solid color-mix(in srgb, var(--color-ink-soft) 30%, transparent)" : undefined,
                        "--page-h": `${dim.h}px`,
                      } as React.CSSProperties
                    }
                  >
                    {children}
                  </div>
                  {/* Cale invisible : avec deux colonnes par page, un nombre IMPAIR de colonnes laisserait la dernière page
                      incomplète, donc non atteignable (scrollLeft bridé) ; la cale prolonge la zone défilable jusqu'à elle. */}
                  <span
                    aria-hidden="true"
                    data-testid="cale-fin-de-page"
                    style={{ position: "absolute", top: 0, left: Math.max(0, finDernierePage(total, dim.w) - 1), width: 1, height: 1, pointerEvents: "none" }}
                  />
                </div>
              </div>
              {filigrane}
            </div>
          </div>
        )}
      </div>
      <nav aria-label={t("Navigation par pages")} className="mt-2 flex shrink-0 items-center justify-center gap-3 sm:gap-8">
        <button type="button" onClick={() => aller(page - 1)} disabled={page <= 0} className={bouton}>
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          {t("Précédent")}
        </button>
        <p role="status" aria-live="polite" data-testid="page-status" className="whitespace-nowrap font-mono-tag text-xs text-ink-soft">
          {t("Page {n} / {total}", { n: page + 1, total })}
        </p>
        <button type="button" onClick={() => aller(page + 1)} disabled={page >= total - 1} className={bouton}>
          {t("Suivant")}
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </nav>
    </div>
  );
}
