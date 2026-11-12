import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Lock, LockOpen } from "lucide-react";
import { api } from "../api/client";
import { t } from "../i18n";
import { classeLabel } from "../lib/referentiel";
import { CatalogueSkeleton } from "./Skeleton";

interface AnneeItem {
  id: string;
  annee: string;
  filieres: string[];
  corrige_disponible: boolean;
  acces: "gratuit" | "ouvert" | "payant";
}
interface Groupe {
  matiere: string;
  evaluation: string;
  classe: string;
  nb_epreuves: number;
  annees: AnneeItem[];
}
interface Reponse {
  total: number;
  groupes: Groupe[];
}

const PAGE = 12;
/** Nombre d'années visibles avant « + N » : la carte reste compacte. */
const VISIBLES = 6;

/** Catalogue REGROUPÉ : une carte par matière × évaluation, les années en
 *  pastilles. `params` = filtres de la page SANS pagination. La pagination
 *  porte sur les groupes (jamais coupés entre deux pages). */
export function CatalogueGroupes({
  params,
  afficherClasse,
  onOpen,
}: {
  params: string;
  afficherClasse: boolean;
  onOpen: (a: AnneeItem) => void;
}) {
  const [groupes, setGroupes] = useState<Groupe[]>([]);
  const [total, setTotal] = useState(0);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState(false);
  const [plus, setPlus] = useState(false);
  const [deplies, setDeplies] = useState<Set<string>>(new Set());
  const seq = useRef(0);

  const charger = useCallback(
    async (offset: number, signal?: AbortSignal) => {
      const jeton = ++seq.current;
      offset === 0 ? setChargement(true) : setPlus(true);
      setErreur(false);
      try {
        const r = await api.get<Reponse>(`/api/epreuves/groupes?${params}&limit=${PAGE}&offset=${offset}`, undefined, signal);
        if (jeton !== seq.current) return; // réponse d'un filtre périmé
        setTotal(r.total);
        setGroupes((prev) => (offset === 0 ? r.groupes : [...prev, ...r.groupes]));
      } catch {
        if (jeton === seq.current && !signal?.aborted) setErreur(true);
      } finally {
        if (jeton === seq.current) {
          setChargement(false);
          setPlus(false);
        }
      }
    },
    [params]
  );

  useEffect(() => {
    const ac = new AbortController();
    setDeplies(new Set());
    void charger(0, ac.signal);
    return () => ac.abort();
  }, [charger]);

  const cle = (g: Groupe) => `${g.matiere}|${g.evaluation}|${g.classe}`;
  const basculer = (k: string) =>
    setDeplies((prev) => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  if (chargement) return <CatalogueSkeleton />;
  if (erreur && groupes.length === 0)
    return (
      <div role="alert" className="rounded-lg border border-correction/30 bg-correction-soft p-4 text-correction">
        {t("Le catalogue n'a pas pu être chargé.")}{" "}
        <button type="button" onClick={() => void charger(0)} className="underline">
          {t("Réessayer")}
        </button>
      </div>
    );
  if (groupes.length === 0) return <p className="text-sm text-slate">{t("Aucune épreuve ne correspond à ces filtres.")}</p>;

  return (
    <div className="space-y-4">
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {groupes.map((g) => {
          const k = cle(g);
          const ouvert = deplies.has(k);
          const visibles = ouvert ? g.annees : g.annees.slice(0, VISIBLES);
          const cachees = g.annees.length - visibles.length;
          const gratuites = g.annees.filter((a) => a.acces === "gratuit").length;
          return (
            <li key={k} className="flex flex-col gap-3 rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
              <div>
                <h3 className="font-serif-brand text-lg leading-snug">{g.matiere}</h3>
                <p className="font-mono-tag text-[11px] text-slate">
                  {g.evaluation}
                  {afficherClasse ? ` · ${classeLabel(g.classe)}` : ""} ·{" "}
                  {t(g.nb_epreuves > 1 ? "{n} épreuves" : "{n} épreuve", { n: g.nb_epreuves })}
                  {gratuites > 0 ? ` · ${t(gratuites > 1 ? "{n} gratuites" : "{n} gratuite", { n: gratuites })}` : ""}
                </p>
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {visibles.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(a)}
                      aria-label={`${g.matiere} ${g.evaluation} ${a.annee} — ${t(
                        a.acces === "gratuit" ? "Gratuit" : a.acces === "ouvert" ? "Ouvert" : "Payant"
                      )}${a.corrige_disponible ? `, ${t("Corrigé")}` : ""}`}
                      className={`flex min-h-[36px] items-center gap-1 rounded-full border px-3 text-sm transition-colors hover:border-highlight/60 hover:bg-highlight-soft/50 focus-visible:border-highlight ${
                        a.acces === "payant" ? "border-ink-soft/20 text-ink-soft" : "border-valide/40 text-ink"
                      }`}
                    >
                      {a.annee}
                      {a.acces === "payant" ? (
                        <Lock size={11} strokeWidth={2} aria-hidden="true" />
                      ) : a.acces === "ouvert" ? (
                        <LockOpen size={11} strokeWidth={2} aria-hidden="true" className="text-valide" />
                      ) : null}
                      {a.corrige_disponible && <Check size={11} strokeWidth={2.25} aria-hidden="true" className="text-valide" />}
                    </button>
                  </li>
                ))}
                {(cachees > 0 || ouvert) && g.annees.length > VISIBLES && (
                  <li>
                    <button
                      type="button"
                      onClick={() => basculer(k)}
                      aria-expanded={ouvert}
                      className="min-h-[36px] rounded-full px-3 text-sm text-ink-soft underline"
                    >
                      {ouvert ? t("Afficher moins") : t("Afficher les {n} autres années", { n: cachees })}
                    </button>
                  </li>
                )}
              </ul>
            </li>
          );
        })}
      </ul>
      {erreur && (
        <p role="alert" className="text-center text-sm text-correction">
          {t("Le chargement des épreuves supplémentaires a échoué.")}{" "}
          <button type="button" onClick={() => void charger(groupes.length)} className="underline">
            {t("Réessayer")}
          </button>
        </p>
      )}
      {groupes.length < total && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void charger(groupes.length)}
            disabled={plus}
            className="min-h-[40px] rounded-full border border-ink-soft/25 px-6 text-sm disabled:opacity-50"
          >
            {plus ? t("Chargement…") : t("Voir plus")}
          </button>
        </div>
      )}
    </div>
  );
}
