import type { Broadcast } from "@/data/broadcasts"

export const COLLAPSED_ROWS = 3

/** Data legível no fuso da transmissão, sem o nome técnico do fuso ("23 out 2026, 11:22"). */
export function formatBroadcastDate(value: string | null | undefined, timezone: string): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  const zone = (() => { try { new Intl.DateTimeFormat("pt-BR", { timeZone: timezone }); return timezone } catch { return undefined } })()
  const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: zone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date)
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? ""
  return `${get("day")} ${get("month").replace(".", "")} ${get("year")}, ${get("hour")}:${get("minute")}`
}

/** Agendada pausada antes da hora: o envio ainda não começou, então continua em Agendado (com o selo "Pausado"). */
export function isPausedSchedule(item: Pick<Broadcast, "status" | "started" | "scheduled_at">): boolean {
  return item.status === "paused" && item.started === false && !!item.scheduled_at
}

/** Agendada cuja hora já passou e o envio não começou: a tela avisa "Atrasado" em vez de parecer que ainda vai sair. */
export function isOverdue(item: Pick<Broadcast, "status" | "scheduled_at" | "started">, now = Date.now(), graceMs = 120_000): boolean {
  return item.status === "scheduled" && item.started !== true && !!item.scheduled_at && Date.parse(item.scheduled_at) < now - graceMs
}

export function groupBroadcasts(items: Broadcast[]) {
  const scheduled = (item: Broadcast) => item.status === "scheduled" || isPausedSchedule(item)
  return {
    scheduled: items.filter(scheduled),
    drafts: items.filter(item => item.status === "draft"),
    history: items.filter(item => !scheduled(item) && item.status !== "draft"),
  }
}

export type BroadcastSection = "scheduled" | "drafts" | "history"

/** Linhas por seção antes de "Ver todas": 3 em Agendado, 5 nas outras. */
export function sectionLimit(section: BroadcastSection): number {
  return section === "scheduled" ? COLLAPSED_ROWS : 5
}

/** Há linhas escondidas (mais do que o limite da seção)? Só então vale oferecer "Ver todas". */
export function hasHiddenRows(count: number, section: BroadcastSection): boolean {
  return count > sectionLimit(section)
}

export function visibleRows<T>(rows: T[], showAll: boolean, limit = COLLAPSED_ROWS): T[] {
  return showAll ? rows : rows.slice(0, limit)
}

/** Valor e porcentagem sobre os enviados, para as colunas Entregue, Lido e Clicado do Histórico. */
export function rateCell(value: number | undefined, sent: number | undefined): { value: string; percent: string } {
  const n = value ?? 0
  const pct = sent ? n / sent : 0
  return { value: n.toLocaleString("pt-BR"), percent: `(${new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 }).format(pct)})` }
}
