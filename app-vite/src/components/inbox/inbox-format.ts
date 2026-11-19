const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Tempo curto da linha da conversa: "agora", "5min", "4h", "1d", "2sem". */
export function shortAgo(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso))
  if (diff < MIN) return "agora"
  if (diff < HOUR) return `${Math.floor(diff / MIN)}min`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`
  return `${Math.floor(diff / (7 * DAY))}sem`
}
