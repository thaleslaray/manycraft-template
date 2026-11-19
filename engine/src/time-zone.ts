/** Partes da data e hora de um instante no fuso informado (fuso inválido vale UTC). Usado pelas regras e pela ação Definir campo. */
export function localParts(now: number, timezone: string): Record<string, string> {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const
  let formatter: Intl.DateTimeFormat
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, ...options }) }
  catch { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', ...options }) }
  return Object.fromEntries(formatter.formatToParts(now).map(p => [p.type, p.value]))
}
/** Dia (AAAA-MM-DD) de um instante no fuso informado. */
export function localDate(now: number, timezone: string): string {
  const local = localParts(now, timezone)
  return `${local.year}-${local.month}-${local.day}`
}
