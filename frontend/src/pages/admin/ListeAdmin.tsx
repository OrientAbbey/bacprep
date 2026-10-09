import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import { Skeleton } from "../../components/Skeleton";
import { authHeaders, purgerSessionExpiree } from "./shared";

export interface FiltreListe {
  /** Nom du paramètre de requête. */
  cle: string;
  libelle: string;
  options: [valeur: string, libelle: string][];
  defaut?: string;
}

/**
 * Liste paginée d'administration : champ de recherche (envoyé après 300 ms sans frappe), filtres à
 * choix, zone défilante de hauteur BORNÉE et bouton « Charger plus » (le serveur renvoie `taille`
 * éléments par page). Une réponse périmée (filtre changé entre-temps) est ignorée. `rechargement`
 * : incrémenter pour relire la liste depuis le début après une action.
 */
export function ListeAdmin<T extends { id: string }>({
  path,
  token,
  rendu,
  vide,
  recherche,
  filtres = [],
  rechargement = 0,
  taille = 30,
  libelle,
  entete,
}: {
  path: string;
  token: string;
  rendu: (item: T) => ReactNode;
  vide: string;
  recherche?: string;
  filtres?: FiltreListe[];
  rechargement?: number;
  taille?: number;
  libelle: string;
  entete?: ReactNode;
}) {
  const [q, setQ] = useState("");
  const [qEnvoye, setQEnvoye] = useState("");
  const [valeurs, setValeurs] = useState<Record<string, string>>(() => Object.fromEntries(filtres.map((f) => [f.cle, f.defaut ?? ""])));
  const [items, setItems] = useState<T[] | null>(null);
  const [encore, setEncore] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState(false);
  const sequence = useRef(0);

  useEffect(() => {
    const t = window.setTimeout(() => setQEnvoye(q), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const charger = useCallback(
    async (offset: number) => {
      const moi = ++sequence.current;
      setEnCours(true);
      setErreur(false);
      const params = new URLSearchParams({ limit: String(taille), offset: String(offset) });
      if (qEnvoye.trim()) params.set("q", qEnvoye.trim());
      for (const [k, v] of Object.entries(valeurs)) if (v) params.set(k, v);
      try {
        const page = await api.get<T[]>(`${path}?${params}`, authHeaders(token));
        if (moi !== sequence.current) return;
        setItems((prec) => (offset === 0 ? page : [...(prec ?? []), ...page]));
        setEncore(page.length === taille);
      } catch (err) {
        if (moi === sequence.current && !purgerSessionExpiree(err)) setErreur(true);
      } finally {
        if (moi === sequence.current) setEnCours(false);
      }
    },
    [path, token, taille, qEnvoye, valeurs]
  );

  useEffect(() => {
    void charger(0);
  }, [charger, rechargement]);

  const champ = "min-h-[44px] rounded-[2px] border border-ink-soft/25 bg-paper px-3 text-sm";
  return (
    <div className="space-y-3">
      {entete}
      <div className="flex flex-wrap items-center gap-2">
        {recherche && (
          <label className="relative min-w-[200px] flex-1">
            <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={recherche}
              aria-label={recherche}
              className={`${champ} w-full pl-8`}
            />
          </label>
        )}
        {filtres.map((f) => (
          <select
            key={f.cle}
            aria-label={f.libelle}
            value={valeurs[f.cle] ?? ""}
            onChange={(e) => setValeurs((v) => ({ ...v, [f.cle]: e.target.value }))}
            className={champ}
          >
            {f.options.map(([valeur, lib]) => (
              <option key={valeur} value={valeur}>
                {lib}
              </option>
            ))}
          </select>
        ))}
      </div>

      {erreur && (
        <div role="alert" className="rounded-lg border border-correction/30 bg-correction-soft p-4 text-sm text-correction">
          <p>La liste n'a pas pu être chargée.</p>
          <button type="button" onClick={() => void charger(0)} className="mt-1 min-h-[44px] underline">
            Réessayer
          </button>
        </div>
      )}
      {!items && !erreur && (
        <div className="space-y-2 rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className={`h-4 ${i % 2 === 0 ? "w-full" : "w-2/3"}`} />
          ))}
        </div>
      )}
      {items && items.length === 0 && !erreur && (
        <p className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5 text-sm text-slate">{vide}</p>
      )}
      {items && items.length > 0 && (
        // Hauteur BORNÉE : la liste défile à l'intérieur, la page garde une longueur fixe.
        <ul aria-label={libelle} data-liste-admin className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {items.map((it) => (
            <li key={it.id}>{rendu(it)}</li>
          ))}
          {encore && (
            <li className="pt-1 text-center">
              <button
                type="button"
                onClick={() => void charger(items.length)}
                disabled={enCours}
                className="min-h-[44px] rounded-full border border-ink-soft/25 px-4 text-sm disabled:opacity-50"
              >
                {enCours ? "Chargement…" : `Charger plus (${items.length} affichés)`}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
