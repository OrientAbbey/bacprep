import { Bell } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { NotificationsEleve } from "../api/types";
import { formatRelativeTime } from "../lib/time";

/** Pixelle le badge en « 9+ » au-delà de ce seuil (l'œil lit mieux un
 * seuil qu'un grand nombre). */
const MAX_BADGE = 9;

/** Cloche de notifications du menu : badge du nombre de non lues, panneau
 * déroulant listant les notifications actives (titre, message, date
 * relative, lien éventuel vers l'épreuve publiée), avec « Tout marquer
 * comme lu ». Rendu uniquement pour l'utilisateur connecté (les routes
 * /api/notifications exigent une session). */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<NotificationsEleve | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  function load() {
    api
      .get<NotificationsEleve>("/api/notifications")
      .then(setData)
      .catch(() => undefined);
  }

  // Charge à l'ouverture (badge frais avant affichage du panneau).
  useEffect(() => {
    if (open) load();
  }, [open]);

  // Clique à l'extérieur ou Échap → referme le panneau.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function toutMarquerLu() {
    try {
      await api.post("/api/notifications/lues");
      load();
    } catch {
      // Silencieux : l'utilisateur reverra le badge au prochain chargement.
    }
  }

  const non_lues = data?.non_lues ?? 0;
  const items = data?.items ?? [];

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Fermer les notifications" : "Ouvrir les notifications"}
        aria-expanded={open}
        aria-haspopup="true"
        className="relative flex h-9 w-9 items-center justify-center rounded-full hover:bg-highlight-soft after:absolute after:-inset-1 after:rounded-full after:content-['']"
      >
        <Bell size={20} strokeWidth={1.75} aria-hidden="true" />
        {non_lues > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-correction px-1 font-mono-tag text-[9px] font-bold leading-none text-paper"
          >
            {Math.min(non_lues, MAX_BADGE)}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-12 z-50 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-ink-soft/15 bg-paper-raised shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-ink-soft/15 px-4 py-3">
            <p className="font-serif-brand text-sm">Notifications</p>
            {non_lues > 0 && (
              <button
                type="button"
                onClick={toutMarquerLu}
                className="min-h-[32px] rounded-full border border-valide/40 px-3 text-xs font-medium text-valide hover:bg-valide-soft/40"
              >
                Tout marquer comme lu
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate">
              Aucune notification pour l'instant.
            </p>
          ) : (
            <ul className="max-h-80 divide-y divide-ink-soft/10 overflow-y-auto">
              {items.map((n) => (
                <li key={n.id} className={n.lue ? "opacity-60" : ""}>
                  <div className="px-4 py-3">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {!n.lue && (
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-correction"
                        />
                      )}
                      {n.titre}
                    </p>
                    {n.message && <p className="mt-1 text-xs text-ink-soft">{n.message}</p>}
                    <p className="mt-1.5 font-mono-tag text-[10px] text-slate">
                      {formatRelativeTime(n.created_at)}
                    </p>
                    {n.epreuve_id && (
                      <Link
                        to={`/epreuve/${n.epreuve_id}`}
                        onClick={() => setOpen(false)}
                        className="mt-1.5 inline-block text-xs font-medium text-highlight underline hover:text-ink"
                      >
                        Aller à l'épreuve
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}