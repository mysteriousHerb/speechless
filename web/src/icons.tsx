/** Inline SVG icons. All are decorative; the buttons that hold them carry the labels. */

const common = { width: 24, height: 24, viewBox: '0 0 24 24', 'aria-hidden': true as const }
const stroke = {
  ...common,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

/** The mark: an ink square with three dots, the last one lit. Matches public/icon.svg. */
export function Logo({ className = 'logo' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 28 28" aria-hidden="true">
      <rect width="28" height="28" rx="8" fill="var(--primary)" />
      <circle cx="9" cy="14" r="2.3" fill="var(--on-primary)" />
      <circle cx="14" cy="14" r="2.3" fill="var(--on-primary)" />
      <circle cx="19" cy="14" r="2.3" fill="#ff7a4d" />
    </svg>
  )
}

export function GearIcon() {
  return (
    <svg {...stroke} strokeWidth={1.8}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}

export function MicIcon() {
  return (
    <svg {...stroke}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
    </svg>
  )
}

export function PencilIcon() {
  return (
    <svg {...stroke}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

export function RepeatIcon() {
  return (
    <svg {...stroke}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  )
}

export function ChevronLeftIcon() {
  return (
    <svg {...stroke} strokeWidth={2.2}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

export function PlayIcon() {
  return (
    <svg {...common} fill="currentColor" stroke="none">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.8l-10-6.5A1 1 0 0 0 8 5.5z" />
    </svg>
  )
}

export function StopIcon() {
  return (
    <svg {...common} fill="currentColor" stroke="none">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}
