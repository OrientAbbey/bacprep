export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      role="img"
    >
      <rect x="1" y="1" width="38" height="38" rx="7" fill="#1B2A4A" />
      <path
        d="M12 12h11a4 4 0 0 1 4 4v0a4 4 0 0 1-4 4H15v6"
        stroke="#F6F2E7"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M14 24l2.4 2.6L21 21.5"
        stroke="#C89B3C"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
