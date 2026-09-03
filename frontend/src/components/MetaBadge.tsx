import React from "react";

export type BadgeTone = "default" | "correction" | "valide" | "highlight";

const TONE_CLASSES: Record<BadgeTone, string> = {
  default: "border-ink-soft/25 bg-paper text-ink-soft",
  correction: "border-correction/40 bg-correction-soft text-correction",
  valide: "border-valide/40 bg-valide-soft text-valide",
  // Le ton highlight utilise text-highlight-ink (jamais text-ink, cf. contraste)
  highlight: "border-highlight/50 bg-highlight-soft text-highlight-ink",
};

export function MetaBadge({
  children,
  tone = "default",
  className = "",
  title,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  className?: string;
  title?: string;
  "aria-label"?: string;
}) {
  return (
    <span
      title={title}
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 font-mono-tag text-[11px] ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
