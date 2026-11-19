import { NonRetryableError } from 'cloudflare:workflows'
import type { Env } from '../env'
import { inlineMemo } from './inline-timing'

/** Read mutable state inside each retryable side effect; the loaded graph is intentionally frozen. */
export async function assertRunActive(env: Pick<Env, 'DB'>, runId: string, options: { fresh?: boolean } = {}) {
  // Broadcast snapshots use deleted_at as an internal visibility marker, not as the user's trash action.
  // Envio pela API (sendContent) também usa uma automação interna escondida (prefixo api-content-).
  // Execução em linha: passos repetíveis seguidos (ms de distância) usam a mesma leitura; um passo com efeito relê (forgetVolatile).
  const read = () => env.DB.prepare(`SELECT r.status,c.status AS contact_status,a.deleted_at,a.id AS automation_id,
    EXISTS (SELECT 1 FROM broadcasts b WHERE b.workspace_id=a.workspace_id AND b.automation_id=a.id) AS internal_broadcast FROM flow_runs r
    JOIN contacts c ON c.workspace_id=r.workspace_id AND c.id=r.contact_id
    JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id
    JOIN automations a ON a.workspace_id=v.workspace_id AND a.id=v.automation_id WHERE r.id=?`).bind(runId)
    .first<{ status: string; contact_status: string; deleted_at: number | null; internal_broadcast: number; automation_id: string }>()
  const row = options.fresh ? await read() : await inlineMemo(`v:active:${runId}`, read)
  if (!row || row.status === 'cancelled' || row.contact_status === 'deleted' || (row.deleted_at !== null && !row.internal_broadcast && !String(row.automation_id ?? '').startsWith('api-content-'))) throw new NonRetryableError('Flow run cancelled')
}
