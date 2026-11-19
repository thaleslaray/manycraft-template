/** Junta palavras novas à lista: apara, ignora vazias, ignora repetidas (sem diferenciar maiúsculas) e respeita o limite. */
export function mergeKeywords(value: string[], raw: string[], max = 10): { next: string[]; dup: string; full: boolean } {
  let next = [...value]
  let dup = ""
  let full = false
  for (const w of raw.map((s) => s.trim()).filter(Boolean)) {
    if (next.some((x) => x.toLowerCase() === w.toLowerCase())) { dup = w; continue }
    if (next.length >= max) { full = true; break }
    next = [...next, w]
  }
  return { next, dup, full }
}

/** Lista final para salvar: os chips mais o texto ainda não confirmado com Enter. */
export function withPending(value: string[], pending: string, max = 10): string[] {
  return pending.trim() ? mergeKeywords(value, pending.split(/[,\n]/), max).next : value
}
