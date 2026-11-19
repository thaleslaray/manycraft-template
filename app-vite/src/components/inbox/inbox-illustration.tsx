/** Ilustração própria do estado sem conversa aberta: dois balões de fala sobrepostos, só com as cores da marca. */
export function InboxIllustration() {
  return (
    <svg viewBox="0 0 240 190" className="h-64 w-80" fill="none" aria-hidden="true">
      {/* balão do contato */}
      <path d="M28 40a18 18 0 0 1 18-18h92a18 18 0 0 1 18 18v52a18 18 0 0 1-18 18H72l-26 22v-22h0a18 18 0 0 1-18-18V40Z" className="fill-accent-soft" />
      <rect x="46" y="44" width="76" height="8" rx="4" className="fill-accent" />
      <rect x="46" y="62" width="100" height="8" rx="4" className="fill-accent" opacity=".55" />
      <rect x="46" y="80" width="56" height="8" rx="4" className="fill-accent" opacity=".35" />
      {/* balão da resposta */}
      <rect x="104" y="86" width="108" height="76" rx="18" className="fill-accent" />
      <path d="M180 160h32l-4 26Z" className="fill-accent" />
      <rect x="116" y="104" width="62" height="8" rx="4" className="fill-on-accent" />
      <rect x="116" y="122" width="82" height="8" rx="4" className="fill-on-accent" opacity=".7" />
      <circle cx="198" cy="40" r="6" className="fill-accent" opacity=".5" />
      <circle cx="214" cy="56" r="3.5" className="fill-accent" opacity=".3" />
    </svg>
  )
}
