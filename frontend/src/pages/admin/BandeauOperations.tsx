import { useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";
import { api } from "../../api/client";
import { ImportJob, SauvegardeJob } from "../../api/types";
import {
  delaiProchainEssai,
  dureeLisible,
  operationsEnCours,
  type OngletOperation,
  type OperationEnCours,
} from "../../lib/jobs";
import { authHeaders } from "./shared";

/** Bandeau « Opérations en cours », visible quel que soit l'onglet.
 *
 *  Sans lui, quitter « Sauvegardes » ou « Import massif » pendant un travail
 *  long faisait perdre toute trace de l'opération : le panneau était démonté,
 *  son état React avec, et rien d'autre ne rappelait qu'un export tournait.
 *  Le bandeau lit les deux listes serveur — la même source que les panneaux —
 *  et propose d'aller à l'onglet concerné.
 */
export function BandeauOperations({
  token,
  onOuvrir,
}: {
  token: string;
  onOuvrir: (onglet: OngletOperation) => void;
}) {
  const [operations, setOperations] = useState<OperationEnCours[]>([]);
  // Échecs consécutifs, pour espacer les essais quand le réseau ou le serveur
  // est indisponible. Un `useRef` et non un état : ce compteur pilote un
  // minuteur, il ne doit provoquer aucun rendu.
  const echecs = useRef(0);

  useEffect(() => {
    let vivant = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function charger() {
      try {
        const [sauvegardes, imports] = await Promise.all([
          api.get<{ jobs: SauvegardeJob[] }>(
            "/api/admin/sauvegardes/jobs",
            authHeaders(token)
          ),
          api.get<ImportJob[]>("/api/admin/import/jobs", authHeaders(token)),
        ]);
        if (!vivant) return;
        echecs.current = 0;
        setOperations(operationsEnCours(sauvegardes.jobs, imports));
      } catch {
        /* Le bandeau est un confort : une erreur ici ne doit pas masquer le
           panneau actif ni produire de message en boucle. Les panneaux
           concernés signalent leurs propres erreurs. On conserve toutefois
           la dernière liste connue : une coupure passagère ne doit pas faire
           croire que l'opération a disparu. */
        echecs.current += 1;
      } finally {
        // `setTimeout` récursif et non `setInterval` : si une requête dépasse
        // l'intervalle (réseau lent, stockage S3 froid), la suivante attend
        // son tour au lieu de s'empiler. Un bandeau ne doit pas devenir la
        // source du ralentissement qu'il sert à expliquer.
        //
        // Après un échec, l'attente double (4 s, 8 s, 16 s… plafonnée à 30 s)
        // au lieu de marteler un serveur en réveil ; le premier succès
        // rétablit la cadence nominale.
        if (vivant) timer = setTimeout(charger, delaiProchainEssai(echecs.current));
      }
    }

    void charger();
    return () => {
      vivant = false;
      if (timer) clearTimeout(timer);
    };
  }, [token]);

  if (operations.length === 0) return null;

  return (
    <section
      role="status"
      aria-live="polite"
      aria-label="Opérations en cours"
      className="rounded-lg border border-highlight/40 bg-highlight-soft/40 p-4"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <Activity size={15} strokeWidth={2} aria-hidden="true" />
        {operations.length === 1
          ? "Une opération est en cours"
          : `${operations.length} opérations sont en cours`}
      </p>
      <ul className="mt-2 space-y-1.5">
        {operations.map((op) => {
          const duree = dureeLisible(op.duree);
          return (
            <li
              key={`${op.type}-${op.id}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm"
            >
              <span className="font-medium">{op.libelle}</span>
              {op.detail && (
                <span
                  className="max-w-full truncate font-mono-tag text-[10px] text-ink-soft"
                  title={op.detail}
                >
                  {op.detail}
                </span>
              )}
              {op.phase && <span className="text-xs text-ink-soft">{op.phase}</span>}
              <span className="text-xs text-slate">
                {duree ? `Écoulé : ${duree}` : "En attente de prise en charge"}
              </span>
              <button
                type="button"
                onClick={() => onOuvrir(op.onglet)}
                className="min-h-[36px] rounded-full border border-ink-soft/25 px-3 text-xs hover:bg-highlight-soft"
              >
                Voir
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
