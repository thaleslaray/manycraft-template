/** Ilustração própria do canal sem conexão: dois balões de conversa se cruzando sobre uma grade, só com as cores da marca. */
export function ChannelArt({ className }: { className?: string }) {
  return (
    <svg role="img" aria-label="Duas conversas se encontrando" viewBox="0 0 240 150" className={className} fill="none">
      <rect x="14" y="96" width="212" height="8" rx="4" className="fill-border" />
      <g className="fill-accent-soft stroke-accent" strokeWidth="2" strokeLinejoin="round">
        <path d="M40 22h92a14 14 0 0 1 14 14v34a14 14 0 0 1-14 14H78l-22 18V84h-16a14 14 0 0 1-14-14V36a14 14 0 0 1 14-14Z" />
      </g>
      <g className="fill-surface stroke-link" strokeWidth="2" strokeLinejoin="round">
        <path d="M118 52h82a14 14 0 0 1 14 14v28a14 14 0 0 1-14 14h-12v16l-20-16h-50a14 14 0 0 1-14-14V66a14 14 0 0 1 14-14Z" />
      </g>
      <g className="fill-accent">
        <circle cx="62" cy="53" r="5" /><circle cx="86" cy="53" r="5" /><circle cx="110" cy="53" r="5" />
      </g>
      <g className="fill-link">
        <rect x="136" y="72" width="56" height="6" rx="3" /><rect x="136" y="86" width="36" height="6" rx="3" />
      </g>
    </svg>
  )
}
