export type Row = Record<string, unknown>

const timestamps = new Set(["created_at", "updated_at", "deleted_at", "subscribed_at", "last_interaction_at", "ad_referred_at",
  "automation_paused_until", "window_expires_at", "human_window_expires_at", "fired_at"])
const booleans = new Set(["locked", "has_unpublished_changes", "opted_in", "case_sensitive", "is_reserved", "archived"])
const json = new Set(["draft_graph", "graph", "config", "bot_value", "value", "words"])

/** D1 stores timestamps in milliseconds, JSON as TEXT and booleans as integers. */
export function decode<T>(row: Row): T {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    value === null ? null : timestamps.has(key) ? new Date(Number(value)).toISOString()
      : booleans.has(key) ? Boolean(value) : json.has(key) && typeof value === "string" ? JSON.parse(value) : value,
  ])) as T
}

export class RepositoryError extends Error {
  constructor(message = "Registro não encontrado.", public readonly status = 404) { super(message) }
}

export function assertWorkspace(workspaceId: string): void {
  if (!workspaceId.trim()) throw new RepositoryError("Workspace obrigatório.", 400)
}

export function requireRow<T>(row: T | null): T {
  if (row === null) throw new RepositoryError()
  return row
}

export function jsonValue(value: unknown): string {
  const result = JSON.stringify(value)
  if (result === undefined) throw new RepositoryError("Valor JSON obrigatório.", 400)
  return result
}

/** Fim da lista do workspace: toda palavra-chave nova nasce com prioridade max+1 (subconsulta avaliada a cada INSERT, inclusive dentro de um lote). */
export const nextKeywordPrioritySql = '(SELECT coalesce(max(priority),-1)+1 FROM keywords WHERE workspace_id=? AND parent_id IS NULL)'
