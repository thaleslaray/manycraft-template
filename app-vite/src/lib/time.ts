const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" })

/** "há 3 horas", "ontem"… sempre relativo a agora. */
export function timeAgo(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now
  const abs = Math.abs(diff)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ]
  for (const [u, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), u)
  }
  return "agora"
}

export function formatPercent(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—"
  return `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`
}
