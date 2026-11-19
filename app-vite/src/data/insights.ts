import { apiRequest } from "./api"
import { reportFilters, reportQuery, type ReportChannel } from "./dashboard"

export type InsightsPeriod = 7 | 14 | 30 | 90
export type InsightsChannel = ReportChannel
export type InsightsPoint = { date: string; contacts: number; messages: number; clicks: number; new_contacts?: number; unsubscribed?: number; net?: number }
export type InsightsAutomation = { id: string; name: string; contacts: number; messages: number; clicks: number; conversions?: number; revenue?: number }
export type InsightsReport = {
  period: number
  from?: number
  to?: number
  points: InsightsPoint[]
  automations: InsightsAutomation[]
  totals: { contacts: number; messages: number; clicks: number; clickRate: number | null; delivered?: number; read?: number; emails_collected?: number
    new_contacts?: number; unsubscribed?: number; net?: number; inactive?: number; runs?: number }
  by_channel?: { channel: string; contacts: number; messages: number }[]
  conversions?: { events: { name: string; count: number }[]; revenue: { currency: string; value: number }[] }
}
export type InboxInsights = {
  conversations: number; answered: number; response_rate: number | null; first_response_seconds: number | null; close_seconds: number | null
  agents: { member_id: string; name: string; assigned: number; closed: number }[]
}

export async function getInsights(_workspace: string, period: InsightsPeriod, channel: InsightsChannel = "all"): Promise<InsightsReport> {
  if (![7, 14, 30, 90].includes(period)) throw new Error("Escolha um período de 7, 14, 30 ou 90 dias.")
  if (!["all", "telegram", "instagram", "whatsapp", "messenger", "email", "tiktok"].includes(channel)) throw new Error("Escolha um canal disponível.")
  return apiRequest<InsightsReport>(`/insights?${reportQuery(reportFilters(period, channel))}`)
}
/** Caixa de entrada no período (até 3 meses). */
export async function getInboxInsights(period: InsightsPeriod): Promise<InboxInsights> {
  return apiRequest<InboxInsights>(`/insights/inbox?${reportQuery(reportFilters(period, "all"))}`)
}
