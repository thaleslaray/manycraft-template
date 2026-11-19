import { z } from 'zod'
import { RepositoryError, requireRow, type Row } from './shared'
import { getAutomation, SHARE_TO_DM_WIDGET } from './automations'
import { AD_WIDGETS } from '../channels/ad-origin'
import { triggerTypeOf } from '../../../shared/trigger-types'
import type { ChannelType } from '../contracts'

/** Gatilhos sem painel de palavras: Hotmart, entrada externa (API), anúncio, compartilhamento no direct e carrinho. */
const widgets = [...AD_WIDGETS, 'tiktok_ads_ctx', SHARE_TO_DM_WIDGET].map(w => `'${w}'`).join(',')
export const externalWhere = `((t.kind='external_trigger' AND json_extract(t.config,'$.system_kind') IS NULL AND (json_extract(t.config,'$.source')='hotmart' OR json_extract(t.config,'$.trigger_name') IS NOT NULL))
  OR t.kind='cart_reply' OR (t.kind='widget' AND t.widget_type IN (${widgets})))`

export const patchExternalSchema = z.object({
  enabled: z.boolean().optional(), state: z.enum(['active', 'draft', 'initial']).optional(),
}).strict().refine(input => input.enabled !== undefined || input.state !== undefined, { message: 'Informe uma alteração.' })

function present(row: Row, ws: string, automation: string) {
  const config = JSON.parse(String(row.config)) as Record<string, unknown>
  const { node_id, ...detail } = config
  return { id: String(row.id), workspace_id: ws, automation_id: automation, channel_id: (row.channel_id as string | null) ?? null, channel_type: (row.channel_type as ChannelType | null) ?? null,
    name: String(row.name), type: config.source === 'hotmart' ? 'hotmart' as const : triggerTypeOf(String(row.kind), row.widget_type as string | null), node_id: typeof node_id === 'string' ? node_id : null, external: detail,
    enabled: row.status === 'active', active: row.status === 'active',
    state: row.status === 'active' ? 'active' as const : row.status === 'initial' ? 'initial' as const : 'draft' as const,
    repeat_mode: row.repeat_mode as 'once' | 'every_time' | 'once_per_24_hours', keywords: [],
    created_at: new Date(Number(row.created_at)).toISOString(), updated_at: new Date(Number(row.updated_at)).toISOString() }
}

export async function externalTriggerRows(db: D1Database, ws: string, automation: string) {
  const rows = await db.prepare(`SELECT t.*,ch.type AS channel_type FROM triggers t LEFT JOIN channels ch ON ch.workspace_id=t.workspace_id AND ch.id=t.channel_id
    WHERE t.workspace_id=? AND t.automation_id=? AND ${externalWhere} AND t.status<>'disabled' ORDER BY t.created_at,t.id`).bind(ws, automation).all<Row>()
  return rows.results.map(row => present(row, ws, automation))
}

/** Liga ou desliga um gatilho deste grupo. Só liga com a automação publicada e o passo do gatilho na versão publicada. */
export async function patchExternalTrigger(db: D1Database, ws: string, automation: string, triggerId: string, input: unknown) {
  const patch = patchExternalSchema.parse(input)
  const detail = requireRow(await getAutomation(db, ws, automation))
  const old = requireRow(await db.prepare(`SELECT t.* FROM triggers t WHERE t.workspace_id=? AND t.automation_id=? AND t.id=? AND ${externalWhere} AND t.status<>'disabled'`).bind(ws, automation, triggerId).first<Row>())
  const status = patch.state ?? (patch.enabled ? 'active' : 'draft')
  const nodeId = (JSON.parse(String(old.config)) as { node_id?: string }).node_id
  if (status === 'active') {
    if (!detail.published_version) throw new RepositoryError('Publique a automação antes de ativar este gatilho.', 409)
    if (nodeId && !detail.published_version.graph.nodes.some(node => node.id === nodeId)) throw new RepositoryError('Publique o rascunho antes de ativar este gatilho.', 409)
  }
  await db.prepare('UPDATE triggers SET status=?,updated_at=? WHERE workspace_id=? AND automation_id=? AND id=?').bind(status, Date.now(), ws, automation, triggerId).run()
  return requireRow((await externalTriggerRows(db, ws, automation)).find(t => t.id === triggerId) ?? null)
}
