import { useId } from "react";

export function Watermark({ label }: { label: string }) {
  // useId : id unique par instance — deux filigranes simultanés ne
  // partageraient plus le même id de pattern SVG (collision évitée).
  const patternId = useId();
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      preserveAspectRatio="none"
    >
      <defs>
        <pattern
          id={patternId}
          patternUnits="userSpaceOnUse"
          width="340"
          height="160"
          patternTransform="rotate(-24)"
        >
          <text
            x="0"
            y="80"
            fontFamily="IBM Plex Mono, monospace"
            fontSize="13"
            fill="var(--color-ink)"
            opacity="0.04"
          >
            {label}
          </text>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  );
}
