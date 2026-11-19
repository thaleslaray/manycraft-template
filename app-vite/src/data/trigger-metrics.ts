import { apiRequest, isFakeMode } from "./api"

export type TriggerMetric = "runs" | "optins" | "sent" | "delivered" | "read" | "clicked" | "ctr"
export type TriggerMetricsData = Record<Exclude<TriggerMetric, "ctr" | "delivered" | "read">, number> & { ctr: number | null; /** null: o canal não avisa entrega/leitura. */ delivered: number | null; read: number | null; impressions?: number | null; unique_contacts?: number; emails?: number; phones?: number }
export type MetricContact = { id: string; first_name: string | null; last_name: string | null; status: string }
export type MetricContactsPage = { contacts: MetricContact[]; next_cursor: string | null }
export type TriggerMetricsFilter = { trigger_id?: string; period_days?: number }

function query(filter: TriggerMetricsFilter): URLSearchParams {
  const params = new URLSearchParams({ period_days: String(filter.period_days ?? 30) })
  if (filter.trigger_id) params.set("trigger_id", filter.trigger_id)
  return params
}

export async function getTriggerMetrics(automationId: string, filter: TriggerMetricsFilter = {}): Promise<TriggerMetricsData> {
  if (isFakeMode()) return { runs: 0, optins: 0, sent: 0, delivered: 0, read: 0, clicked: 0, ctr: null, impressions: null }
  return apiRequest(`/automations/${encodeURIComponent(automationId)}/trigger-metrics?${query(filter)}`)
}

export async function getMetricContacts(automationId: string, metric: TriggerMetric,
  filter: TriggerMetricsFilter & { cursor?: string } = {}): Promise<MetricContactsPage> {
  if (isFakeMode()) return { contacts: [], next_cursor: null }
  const params = query(filter)
  params.set("metric", metric)
  if (filter.cursor) params.set("cursor", filter.cursor)
  return apiRequest(`/automations/${encodeURIComponent(automationId)}/metric-contacts?${params}`)
}
