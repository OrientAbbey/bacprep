import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import { api } from "../../api/client";
import { AdminEvent } from "../../api/types";
import { Skeleton } from "../../components/Skeleton";
import { formatRelativeTime } from "../../lib/time";
import { authHeaders, purgerSessionExpiree } from "./shared";

/** Journal d'audit : chronologie des actions admin (login/logout, CRUD,
 *  imports, signalements résolus…). L'id d'épreuve est CLIQUABLE (ouvre
 *  l'épreuve dans la section Épreuves) et chaque entrée porte son détail
 *  lisible (champs modifiés, fichier supprimé, résumé d'épreuve…). */
export function JournalPanel({
  token,
  onOuvrirEpreuve,
}: {
  token: string;
  onOuvrirEpreuve: (id: string) => void;
}) {
  const [events, setEvents] = useState<AdminEvent[] | null>(null);
  const [erreur, setErreur] = useState(false);

  function load() {
    setErreur(false);
    api
      .get<AdminEvent[]>("/api/admin/events?limit=100", authHeaders(token))
      .then(setEvents)
      .catch((err) => {
        if (!purgerSessionExpiree(err)) setErreur(true);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (erreur)
    return (
      <div
        role="alert"
        className="rounded-lg border border-correction/30 bg-correction-soft p-5 text-sm text-correction"
      >
        <p>Le journal n'a pas pu être chargé.</p>
        <button type="button" onClick={load} className="mt-2 underline">
          Réessayer
        </button>
      </div>
    );
  if (!events)
    return (
      <div className="space-y-2 rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className={`h-4 ${i % 2 === 0 ? "w-full" : "w-2/3"}`} />
        ))}
      </div>
    );
  if (events.length === 0)
    return (
      <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5 text-sm text-slate">
        Aucun évènement enregistré pour l'instant.
      </div>
    );

  return (
    <div className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5">
      <div className="mb-3 flex items-center gap-2">
        <ScrollText size={18} strokeWidth={1.75} aria-hidden="true" className="text-highlight" />
        <h2 className="font-serif-brand text-lg">Journal d'audit</h2>
      </div>
      {/* 20 lignes visibles ; le reste défile dans le panneau — sans borne,
          le journal (100 entrées chargées) enfonçait les statistiques et
          obligeait à toute la page pour la première entrée. */}
      <ul className="max-h-[720px] divide-y divide-ink-soft/10 overflow-y-auto pr-1 text-sm">
        {events.map((e) => {
          const details = detailsLisibles(e);
          return (
            <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2">
              <span className="font-mono-tag text-[10px] text-slate">{libelleAction(e.action)}</span>
              <span className="min-w-0 flex-1 truncate">
                {e.email || "système"}
                {e.epreuve_id && (
                  <>
                    {" — "}
                    <button
                      type="button"
                      onClick={() => onOuvrirEpreuve(e.epreuve_id!)}
                      title={e.epreuve_resume || `Ouvrir l'épreuve ${e.epreuve_id} dans la section Épreuves`}
                      className="font-mono-tag text-[11px] text-ink underline decoration-dotted underline-offset-2 hover:text-ink-soft"
                    >
                      épreuve {e.epreuve_id}
                    </button>
                    {e.epreuve_resume ? <span className="text-xs text-ink-soft"> ({tronquer(e.epreuve_resume)})</span> : null}
                  </>
                )}
                {details ? <span className="text-xs text-slate"> — {tronquer(details)}</span> : null}
              </span>
              <span className="font-mono-tag text-[10px] text-slate" title={new Date(e.created_at).toLocaleString("fr-FR")}>
                {formatRelativeTime(e.created_at)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Longueur maximale d'une entrée de journal (résumé d'épreuve, détails) —
 * au-delà, le texte est tronqué sur un mot et signalé par « … » : les
 * lignes du journal restent lisibles sans étirer toute la colonne. */
const INTREE_MAX_CHARS = 140;

function tronquer(texte: string, max: number = INTREE_MAX_CHARS): string {
  const plat = texte.replace(/\s+/g, " ").trim();
  if (plat.length <= max) return plat;
  const coupe = plat.slice(0, max);
  return `${coupe.replace(/\s+\S*$/, "")}…`;
}

/** Détails d'un évènement d'audit traduits en phrase lisible (au lieu du
 * JSON brut) selon le type d'action : champs modifiés, fichier supprimé,
 * motif de bannissement, etc. */
function detailsLisibles(e: AdminEvent): string {
  const d = e.details ?? {};
  const parts: string[] = [];
  if (Array.isArray(d.champs) && d.champs.length > 0) {
    parts.push(`champs : ${(d.champs as string[]).join(", ")}`);
  }
  if (typeof d.filename === "string" && d.filename) parts.push(`fichier « ${d.filename} »`);
  if (typeof d.matiere === "string" && d.matiere) parts.push(`${d.matiere}${d.classe ? ` — ${d.classe}` : ""}${d.annee ? ` (${d.annee})` : ""}`);
  if (typeof d.motif === "string" && d.motif) parts.push(`motif : ${d.motif}`);
  if (typeof d.email_cible === "string" && d.email_cible) parts.push(d.email_cible);
  if (typeof d.statut === "string" && d.statut) parts.push(`→ ${d.statut}`);
  return parts.join(" · ");
}

function libelleAction(action: string): string {
  const noms: Record<string, string> = {
    admin_login: "CONNEXION ADMIN",
    admin_logout: "DÉCONNEXION ADMIN",
    created: "CRÉATION",
    updated: "MODIFICATION",
    published: "PUBLICATION",
    unpublished: "DÉPUBLICATION",
    deleted: "SUPPRESSION",
    signalement_resolu: "SIGNALEMENT RÉSOLU",
    utilisateur_banni: "UTILISATEUR BANNI",
    utilisateur_debanni: "UTILISATEUR DÉBANNI",
    utilisateur_supprime: "UTILISATEUR SUPPRIMÉ",
  };
  if (noms[action]) return noms[action];
  if (action.startsWith("image_uploaded")) return `IMAGE AJOUTÉE (${action.split("_").pop()})`;
  if (action.startsWith("document_uploaded")) return `DOCUMENT REMPLACÉ (${action.split("_").pop()})`;
  if (action.startsWith("file_deleted")) return "FICHIER SUPPRIMÉ";
  if (action.startsWith("import")) return "IMPORT";
  return action.toUpperCase();
}