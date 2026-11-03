import { Copy, Mail, MessageCircle, Send, Share2, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { liensPartage, partageNatifDisponible, texteInvitation, urlSite, type LienPartage } from "../lib/invitation";
import { copierTexte } from "../lib/pressePapiers";
import { useModalFocus } from "../lib/useModalFocus";
import { useToast } from "./Toast";

const ICONES: Record<LienPartage["id"], ReactNode> = {
  whatsapp: <MessageCircle size={18} strokeWidth={1.75} aria-hidden="true" />,
  facebook: <span aria-hidden="true" className="w-[18px] text-center font-serif-brand text-lg font-bold leading-none">f</span>,
  telegram: <Send size={18} strokeWidth={1.75} aria-hidden="true" />,
  email: <Mail size={18} strokeWidth={1.75} aria-hidden="true" />,
};

const BOUTON = "flex min-h-[44px] items-center gap-3 rounded-lg border border-ink-soft/20 px-3 text-sm hover:bg-highlight-soft";

function DialogueInvitation({ onClose }: { onClose: () => void }) {
  const { showToast } = useToast();
  const boite = useModalFocus<HTMLDivElement>({ open: true, onClose });
  const url = urlSite(window.location.origin);
  const texte = texteInvitation();

  async function copier() {
    showToast(await copierTexte(url) ? t("Lien copié.") : t("Copie impossible — sélectionne le lien et copie-le à la main."), "info");
  }
  async function autresApplications() {
    try {
      await navigator.share({ title: "Copies & Corrigés", text: texte, url });
      onClose();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) showToast(t("Le partage n'a pas pu s'ouvrir — utilise l'un des boutons."), "error");
    }
  }

  return createPortal(
    <div ref={boite} className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/50 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="invitation-titre">
      <div className="w-full max-w-sm rounded-lg border border-ink-soft/15 bg-paper-raised p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2">
          <h2 id="invitation-titre" className="font-serif-brand text-lg">
            {t("Inviter des amis")}
          </h2>
          <button type="button" onClick={onClose} aria-label={t("Fermer")} className="flex min-h-[44px] min-w-[44px] items-center justify-center">
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <p className="mt-1 text-sm text-ink-soft">{texte}</p>
        <p className="mt-2 break-all rounded-md bg-paper px-3 py-2 font-mono text-xs normal-case text-ink-soft">{url}</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {liensPartage(url, texte).map((l) => (
            <a key={l.id} href={l.href} target={l.id === "email" ? undefined : "_blank"} rel="noopener noreferrer" className={BOUTON}>
              {ICONES[l.id]}
              {l.label}
            </a>
          ))}
          <button type="button" onClick={copier} className={BOUTON}>
            <Copy size={18} strokeWidth={1.75} aria-hidden="true" />
            {t("Copier le lien")}
          </button>
          {partageNatifDisponible() && (
            <button type="button" onClick={autresApplications} className={`${BOUTON} col-span-2 justify-center bg-ink text-paper hover:bg-ink hover:opacity-90`}>
              <Share2 size={18} strokeWidth={1.75} aria-hidden="true" />
              {t("Autres applications…")}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Bouton « Inviter » (icône seule dans l'en-tête, ou lien texte ailleurs) qui ouvre le partage du site. */
export function BoutonInviter({ variante, className = "" }: { variante: "icone" | "lien"; className?: string }) {
  const [ouvert, setOuvert] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOuvert(true)}
        aria-label={variante === "icone" ? t("Inviter des amis") : undefined}
        title={variante === "icone" ? t("Inviter des amis") : undefined}
        className={className}
      >
        {variante === "icone" ? <Share2 size={20} strokeWidth={1.75} aria-hidden="true" /> : t("Inviter des amis")}
      </button>
      {ouvert && <DialogueInvitation onClose={() => setOuvert(false)} />}
    </>
  );
}
