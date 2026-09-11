import { Database, MessagesSquare, StickyNote } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { useModalFocus } from "../lib/useModalFocus";

/**
 * Consentement granulaire recueilli À LA PREMIÈRE CONNEXION (pratique RGPD :
 * libre, spécifique, univoque, révocable). Deux finalités indépendantes :
 * le stockage des conversations IA et celui des notes. Un refus est effectif
 * immédiatement côté serveur (gardes 403) : l'assistant fonctionne alors en
 * mode éphémère et la prise de note est masquée. Révocable depuis la page
 * Profil.
 *
 * La modale est BLOQUANTE : elle ne se ferme qu'une fois le choix
 * ENREGISTRÉ ET RECONFIRMÉ par le serveur (relecture de /api/auth/me —
 * les champs renvoyés doivent refléter exactement les cases cochées).
 * En cas d'échec réseau ou serveur, elle reste affichée avec un message
 * d'erreur et le bouton reste disponible pour réessayer.
 */
export function ConsentModal() {
  const { user, refreshConsentement } = useAuth();
  const [iaOk, setIaOk] = useState(false);
  const [notesOk, setNotesOk] = useState(false);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState(false);

  // Piège le focus Tab à l'intérieur de la modale ; Échap ne ferme RIEN
  // ici (modale bloquante tant que le choix n'est pas enregistré) — le
  // hook ne fait donc qu'empêcher la Tab d'en sortir et rendre le focus
  // à la page à la fermeture.
  const dialogRef = useModalFocus<HTMLDivElement>({ open: true, onClose: () => {} });

  // La modale ne s'affiche que tant que l'utilisateur n'a jamais répondu
  // (les deux choix restent à null après la première réponse, même refus).
  if (!user || user.consent_ia !== null) return null;

  async function envoyer() {
    setEnvoi(true);
    setErreur(false);
    try {
      await api.put("/api/me/consentement", {
        partage_conversations_ia: iaOk,
        partage_notes: notesOk,
      });
      // Confirmation serveur : on ne considère le choix enregistré que si la
      // relecture (/api/auth/me) renvoie EXACTEMENT les valeurs choisies —
      // sinon (serveur en retard, réponse incohérente) la modale reste
      // ouverte et l'élève peut réessayer.
      const me = await refreshConsentement();
      if (!me || me.consent_ia !== iaOk || me.consent_notes !== notesOk) {
        throw new Error("confirmation serveur incohérente");
      }
    } catch {
      setErreur(true);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-titre"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-lg border border-ink-soft/15 bg-paper-raised p-5 shadow-2xl"
      >
        <div className="flex items-center gap-2">
          <Database size={18} strokeWidth={1.75} aria-hidden="true" className="text-highlight" />
          <h2 id="consent-titre" className="font-serif-brand text-lg">
            Tes données, ton choix
          </h2>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          Pour fonctionner, Tuteur IA Prep et tes notes doivent être enregistrés sur nos
          serveurs. Tu décides quoi, et tu peux changer d'avis à tout moment dans ton
          profil. Sans ton accord, la fonctionnalité concernée reste utilisable mais rien
          n'est conservé après la session.
        </p>

        <fieldset className="mt-4 space-y-2">
          <legend className="font-mono-tag text-xs text-ink-soft">CE QUE TU AUTORISES</legend>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-soft/15 bg-paper p-3">
            <input
              type="checkbox"
              checked={iaOk}
              onChange={(e) => setIaOk(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-highlight)]"
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <MessagesSquare size={14} strokeWidth={1.75} aria-hidden="true" className="text-highlight" />
                Mes conversations avec Tuteur IA Prep
              </span>
              <span className="mt-0.5 block text-xs text-slate">
                Retrouve tes discussions et leurs onglets à ta prochaine visite.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-soft/15 bg-paper p-3">
            <input
              type="checkbox"
              checked={notesOk}
              onChange={(e) => setNotesOk(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-highlight)]"
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <StickyNote size={14} strokeWidth={1.75} aria-hidden="true" className="text-highlight" />
                Mes notes personnelles
              </span>
              <span className="mt-0.5 block text-xs text-slate">
                Garde tes notes liées aux épreuves, consultables depuis ton profil.
              </span>
            </span>
          </label>
        </fieldset>

        {erreur && (
          <p role="alert" className="mt-3 text-sm text-correction">
            Le choix n'a pas pu être enregistré côté serveur — vérifie ta connexion
            puis réessaie.
          </p>
        )}

        <button
          type="button"
          onClick={envoyer}
          disabled={envoi}
          className="mt-4 min-h-[44px] w-full rounded-full bg-ink text-sm font-medium text-paper hover:opacity-90 disabled:opacity-50"
        >
          {envoi ? "Enregistrement…" : erreur ? "Réessayer" : "Confirmer mes choix"}
        </button>
        <p className="mt-2 text-center font-mono-tag text-[10px] text-slate">
          TU PEUX REFUSER LES DEUX ET CONTINUER SANS RIEN STOCKER.
        </p>
      </div>
    </div>
  );
}
