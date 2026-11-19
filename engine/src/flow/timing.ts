import { dateSourceSchema, smartDelaySchema, timezoneSchema } from '../schemas/temporal'
import type { z } from 'zod'

type Context = { workspace_id: string; contact_id: string }
type Offset = { value: number; unit: 'minutes' | 'hours' | 'days'; direction: 'before' | 'after' }
type Window = { from: string; to: string; days: number[] }
const formatters = new Map<string, Intl.DateTimeFormat>()
function parts(at: number, timezone: string) {
  let formatter = formatters.get(timezone)
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); formatters.set(timezone, formatter) }
  const result = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]))
  return { year: +result.year, month: +result.month, day: +result.day, hour: +result.hour, minute: +result.minute, second: +result.second }
}
function wallNumber(at: number, timezone: string) {
  const p = parts(at, timezone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
}
/** Earlier occurrence on repeated clock times; shift forward across nonexistent DST times. */
function wallInstant(wall: number, timezone: string): number {
  const offsets = [...new Set([-86400000, 0, 86400000].map(delta => wallNumber(Math.floor((wall + delta) / 1000) * 1000, timezone) - Math.floor((wall + delta) / 1000) * 1000))]
  const candidates = offsets.map(offset => wall - offset).sort((a, b) => a - b)
  const exact = candidates.find(at => wallNumber(at, timezone) === wall)
  if (exact !== undefined) return exact
  return candidates.filter(at => wallNumber(at, timezone) > wall).sort((a, b) => wallNumber(a, timezone) - wallNumber(b, timezone))[0] ?? candidates.at(-1)!
}
export async function flowTimezone(db: D1Database, context: Context, explicit?: string, contactFirst = true): Promise<string> {
  if (explicit) return timezoneSchema.parse(explicit)
  const row = await db.prepare(`SELECT c.timezone AS contact_timezone,w.timezone AS workspace_timezone FROM contacts c
    JOIN workspaces w ON w.id=c.workspace_id WHERE c.workspace_id=? AND c.id=?`).bind(context.workspace_id, context.contact_id).first<{ contact_timezone: string | null; workspace_timezone: string }>()
  for (const value of [...(contactFirst ? [row?.contact_timezone] : []), row?.workspace_timezone, 'UTC']) if (timezoneSchema.safeParse(value).success) return value!
  return 'UTC'
}
export function dateInstant(value: unknown, timezone: string): number | null {
  if (typeof value !== 'string') return null
  if (!dateSourceSchema.safeParse({ kind: 'specific', at: value }).success) return null
  if (/Z$|[+-]\d{2}:\d{2}$/.test(value)) return Date.parse(value)
  const wall = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : `${value}Z`)
  return wallInstant(wall, timezone)
}
export async function readDate(db: D1Database, context: Context, source: z.infer<typeof dateSourceSchema>, timezone: string): Promise<number | null> {
  if (source.kind === 'specific') return dateInstant(source.at, timezone)
  const row = await db.prepare(`SELECT v.value FROM contact_field_values v JOIN custom_fields f ON f.workspace_id=v.workspace_id AND f.id=v.field_id
    WHERE v.workspace_id=? AND v.contact_id=? AND v.field_id=? AND f.type IN ('date','datetime') AND f.scope='contact' AND f.archived=0`)
    .bind(context.workspace_id, context.contact_id, source.field_id).first<{ value: string }>()
  return row ? dateInstant(JSON.parse(row.value), timezone) : null
}
export function shiftDate(at: number, offset: Offset | undefined, timezone: string): number {
  if (!offset) return at
  const amount = offset.value * (offset.direction === 'before' ? -1 : 1)
  return offset.unit === 'days' ? wallInstant(wallNumber(at, timezone) + amount * 86400000, timezone) : at + amount * (offset.unit === 'hours' ? 3600000 : 60000)
}
export function localDate(at: number, timezone: string) { const p = parts(at, timezone); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` }
export function inTimeWindow(at: number, window: Window, timezone: string): boolean {
  const p = parts(at, timezone), weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  const time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
  return window.from < window.to ? window.days.includes(weekday) && time >= window.from && time < window.to
    : time >= window.from ? window.days.includes(weekday) : time < window.to && window.days.includes((weekday + 6) % 7)
}
export function nextTimeWindow(at: number, window: Window | undefined, timezone: string): number {
  if (!window || inTimeWindow(at, window, timezone)) return at
  // UTC traversal handles repeated/skipped local minutes without inventing local times.
  for (let next = Math.floor(at / 60000) * 60000 + 60000, end = at + 9 * 86400000; next <= end; next += 60000) if (inTimeWindow(next, window, timezone)) return next
  throw new Error('Não há horário disponível na janela configurada.')
}
export async function delayDeadline(db: D1Database, context: Context, input: unknown, now = Date.now()): Promise<number> {
  const config = smartDelaySchema.parse(input), timezone = await flowTimezone(db, context, config.timezone)
  let at: number
  if (config.mode === 'date') {
    const date = await readDate(db, context, config.date!, timezone)
    if (date === null) throw new Error('O campo de data está vazio ou inválido para esta espera.')
    at = shiftDate(date, config.offset, timezone)
  } else at = now + config.duration!.value * { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 }[config.duration!.unit]
  const deadline = nextTimeWindow(Math.max(now, at), config.window, timezone)
  if (deadline - now > 365 * 86400000) throw new Error('A espera pode durar até um ano.')
  return deadline
}
