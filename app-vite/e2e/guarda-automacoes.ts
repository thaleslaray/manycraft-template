import { consulta } from "./helpers"

/** Impressão digital das automações e versões do banco de desenvolvimento. */
export function impressaoAutomacoes(): string {
  const a = consulta(`SELECT id, status, published_version_id, updated_at, length(draft_graph) AS d FROM automations ORDER BY id`)
  const v = consulta(`SELECT id, automation_id, version FROM automation_versions ORDER BY id`)
  return JSON.stringify({ a, v })
}
