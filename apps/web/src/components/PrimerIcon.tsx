interface Props {
  size?: number;
  className?: string;
}

/**
 * An open-book mark with a small "display" rectangle on one page —
 * a quiet nod to Stephenson's primer ("each page was a separate
 * flat-panel display"). Stroke uses currentColor so it adopts the
 * surrounding text color; the inner rect uses currentColor at lower
 * opacity to keep the display motif legible without dominating.
 */
export function PrimerIcon({ size = 20, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* Open book outline (left + right page joined at the spine). */}
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
      {/* Display inset on the left page. */}
      <rect x="4.5" y="6" width="4" height="2.25" rx="0.5" fill="currentColor" opacity="0.55" stroke="none" />
    </svg>
  );
}
