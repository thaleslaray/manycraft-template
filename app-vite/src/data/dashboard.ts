import { apiRequest } from "./api"
import type { AutomationStatus, Id } from "./types"

export type DashboardMetric = {
  key: "contacts" | "new_contacts" | "open_conversations" | "live_automations"
  label: string
  value: number
  delta: number | null
  comparison: string
}
export type DashboardAutomation = { id: Id; name: string; status: AutomationStatus; runs: number; unique_contacts: number }
export type DashboardSummary = { reference_at: string; period_days: number; metrics: DashboardMetric[]; most_used: DashboardAutomation[]; empty: boolean
  checklist?: { key: string; label: string; done: boolean }[]
  channels?: { id: string; name: string; type: string; status: string }[]
  time_saved?: { minutes: number; by_type: { type: "dm" | "comment" | "story" | "other"; messages: number }[] }
  most_engaged?: { contact_id: string; name: string; messages: number }[] }
export type ReportChannel = "all" | "telegram" | "instagram" | "whatsapp" | "messenger" | "email" | "tiktok"
export type ReportFilters = { from: number; to: number; channel?: ReportChannel }

/** Janela móvel em UTC, expressa em segundos para a API. */
export function reportFilters(period: number, channel: ReportChannel = "all", now = Date.now()): ReportFilters {
  const to = Math.floor(now / 1000)
  return { from: to - period * 86_400, to, channel }
}
export function reportQuery(filters: ReportFilters): string {
  if (!Number.isFinite(filters.from) || !Number.isFinite(filters.to) || filters.from >= filters.to) throw new Error("Escolha um período válido.")
  const query = new URLSearchParams({ from: String(filters.from), to: String(filters.to) })
  if (filters.channel && filters.channel !== "all") query.set("channel", filters.channel)
  return query.toString()
}

export async function getDashboard(_workspaceId: Id, filters: ReportFilters = reportFilters(7)): Promise<DashboardSummary> {
  return apiRequest<DashboardSummary>(`/dashboard?${reportQuery(filters)}`)
}
