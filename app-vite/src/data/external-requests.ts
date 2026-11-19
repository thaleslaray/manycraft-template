import { apiRequest, isFakeMode } from "./api"

export type ExternalMapped = { path: string; field_id: string; ok: boolean; value?: unknown; error?: string }
export type ExternalTestResult = { ok: boolean; status: number | null; duration_ms: number; error: { code: string; message: string } | null; preview: string | null; mapped: ExternalMapped[] }
export type ExternalLog = { id: string; level?: "error" | "warning" | "info"; automation_id: string | null; contact_id: string | null; contact_name: string | null; source: "run" | "test"; method: string; target: string
  status: number | null; outcome: "ok" | "error"; error_code: string | null; message: string | null; duration_ms: number; created_at: number
  node_id?: string | null; kind?: "external_request" | "dynamic"; automation_name?: string | null }
export type ExternalContact = { id: string; name: string }

const unavailable = () => new Error("A requisição externa só roda com o motor conectado.")

/** Testa a ação com um contato real. Nada é gravado no contato; a tentativa entra no registro. */
export async function testExternalRequest(action: unknown, contactId: string, automationId?: string): Promise<ExternalTestResult> {
  if (isFakeMode()) throw unavailable()
  return apiRequest("/external-requests/test", { method: "POST", body: JSON.stringify({ action, contact_id: contactId, ...(automationId ? { automation_id: automationId } : {}) }) })
}

export async function listExternalLogs(automationId?: string): Promise<ExternalLog[]> {
  if (isFakeMode()) return []
  const query = new URLSearchParams({ limit: "20", ...(automationId ? { automation_id: automationId } : {}) })
  return (await apiRequest<{ items: ExternalLog[] }>(`/external-requests/logs?${query}`)).items
}

export async function searchExternalContacts(search: string): Promise<ExternalContact[]> {
  if (isFakeMode()) return []
  const query = new URLSearchParams({ ...(search.trim() ? { search: search.trim() } : {}) })
  const page = await apiRequest<{ rows: { id: string; first_name: string | null; last_name: string | null }[] }>(`/contacts?${query}`)
  return page.rows.slice(0, 8).map(row => ({ id: row.id, name: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Contato sem nome" }))
}

/** Configurações > Registros: as últimas tentativas do espaço (30 dias), com filtro de erros e de origem. */
export async function listWorkspaceLogs(filter: { errors?: boolean; kind?: "external_request" | "dynamic"; level?: "error" | "warning" | "info" } = {}): Promise<ExternalLog[]> {
  if (isFakeMode()) return []
  const query = new URLSearchParams({ limit: "100", ...(filter.errors ? { errors: "1" } : {}), ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.level ? { level: filter.level } : {}) })
  return (await apiRequest<{ items: ExternalLog[] }>(`/external-requests/logs?${query}`)).items
}
