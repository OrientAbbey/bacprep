import React from "react";

export type BadgeTone = "default" | "correction" | "valide" | "highlight";
export type BadgeVariant = "tag" | "pill";

const TONE_CLASSES: Record<BadgeTone, string> = {
  default: "border-ink-soft/25 bg-paper text-ink-soft",
  correction: "border-correction/40 bg-correction-soft text-correction",
  valide: "border-valide/40 bg-valide-soft text-valide",
  // Le ton highlight utilise text-highlight-ink (jamais text-ink, cf. contraste)
  highlight: "border-highlight/50 bg-highlight-soft text-highlight-ink",
};

/**
 * Badge de référence de l'application. Deux variantes :
 * - "tag" (défaut) : rectangle à angles quasi droits, pour les métadonnées
 *   de contenu (séries, corrigé disponible) ;
 * - "pill" : capsule ronde, pour les statuts d'accès (Gratuit/Ouvert/Payant)
 *   et toute puce flottante en haut d'une carte.
 * Tous les badges de l'app doivent passer par ici (plus de badge inline).
 */
export function MetaBadge({
  children,
  tone = "default",
  variant = "tag",
  className = "",
  title,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  variant?: BadgeVariant;
  className?: string;
  title?: string;
  "aria-label"?: string;
}) {
  const shape =
    variant === "pill" ? "rounded-full px-2 py-0.5 text-[10px]" : "rounded-sm px-2 py-0.5 text-[11px]";
  return (
    <span
      title={title}
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-1 border font-mono-tag ${shape} ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
