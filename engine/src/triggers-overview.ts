import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { assertUnlocked } from './automation-actions'
import { channelLabel, triggerTypeLabel, triggerTypeOf, typeChannelKey, widgetTypeCode } from '../../shared/trigger-types'

export const triggersOverview = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

type Target = { kind: 'automation'; automation_id: string; automation_name: string } | { kind: 'screen'; screen: 'basic' | 'rules' }
type Item = { id: string; name: string; type_channel: string; type_key?: string; type_code?: number | null; active: boolean; runs_30d: number; target: Target }
type Family = { id: string; label: string; active: number; total: number; runs_30d: number; items: Item[] }
const MAX_ITEMS = 100
export const triggerReplaceSchema = z.object({ automation_id: z.string().min(1).max(128) }).strict()
export const triggerOptInStatusSchema = z.object({ opt_in_status: z.enum(['subscribe', 'do_not_send']) }).strict()
export const triggerFollowUpSchema = z.object({ follow_up: z.object({ after_minutes: z.number().int().min(1).max(10080), automation_id: z.string().min(1).max(128) }).nullable() }).strict()

/** Ordem e nome das famílias. Todas aparecem, inclusive vazias, cada uma com status e contadores próprios. */
const FAMILIES: [string, string][] = [
  ['keywords', 'Palavras-chave'], ['comments', 'Comentários'], ['live', 'Comentários em live'], ['stories', 'Stories (resposta e menção)'],
  ['references', 'Links de referência e QR'], ['ads', 'Anúncios'], ['cart', 'Carrinho de compras'],
  ['basic', 'Boas-vindas e resposta padrão'], ['confirmations', 'Confirmações de inscrição'], ['surfaces', 'Iniciadores e menu'], ['rules', 'Regras'],
  ['externals', 'Gatilhos externos'],
]
/** A família sai do tipo da tela (shared/trigger-types.ts), não do nome guardado no banco. */
const TYPE_FAMILY: Record<string, string> = { dm_keyword: 'keywords', ig_comment: 'comments', ig_story_reply: 'stories', ig_story_mention: 'stories',
  ig_share_to_dm: 'stories', ig_live_comment: 'live', ref_url: 'references', qr_code: 'references', ad: 'ads',
  cart_reply: 'cart', welcome: 'basic', default_reply: 'basic', api: 'externals', hotmart: 'externals', another_flow: 'externals' }

type TriggerRow = { id: string; name: string; kind: string; widget_type: string | null; status: string; automation_id: string; automation_name: string
  config: string; channel_type: string | null; runs: number; automation_status: string }

triggersOverview.get('/triggers/overview', async c => {
  authorize(c.var.principal, 'automation:read')
  z.object({}).strict().parse(c.req.query())
  const ws = c.var.principal.workspaceId, since = Date.now() - 30 * 86400_000
  const [triggers, surfaces, firings, rules] = await Promise.all([
    c.env.DB.prepare(`SELECT t.id,t.name,t.kind,t.widget_type,t.status,t.automation_id,a.name AS automation_name,a.status AS automation_status,t.config,ch.type AS channel_type,
        (SELECT count(*) FROM flow_runs f WHERE f.workspace_id=t.workspace_id AND f.trigger_id=t.id AND f.created_at>=?) AS runs
      FROM triggers t JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id AND a.deleted_at IS NULL
      LEFT JOIN channels ch ON ch.workspace_id=t.workspace_id AND ch.id=t.channel_id
      WHERE t.workspace_id=? AND t.status<>'disabled' ORDER BY t.created_at,t.id`).bind(since, ws).all<TriggerRow>(),
    c.env.DB.prepare(`SELECT s.connection_id,s.kind,s.draft,s.published,ch.type AS channel_type FROM conversation_surfaces s
      JOIN channels ch ON ch.workspace_id=s.workspace_id AND ch.id=s.connection_id AND ch.archived_at IS NULL WHERE s.workspace_id=? ORDER BY s.connection_id,s.kind`).bind(ws).all<{ connection_id: string; kind: string; draft: string; published: string | null; channel_type: string }>(),
    c.env.DB.prepare(`SELECT sf.connection_id,sf.kind,sf.item_id,count(*) AS n FROM surface_firings sf JOIN flow_runs f ON f.id=sf.run_id
      WHERE sf.workspace_id=? AND f.created_at>=? GROUP BY sf.connection_id,sf.kind,sf.item_id`).bind(ws, since).all<{ connection_id: string; kind: string; item_id: string; n: number }>(),
    c.env.DB.prepare(`SELECT r.id,r.name,r.active,(SELECT count(*) FROM rule_executions e WHERE e.workspace_id=r.workspace_id AND e.rule_id=r.id
        AND e.created_at>=? AND e.skipped_at IS NULL) AS runs FROM rules r WHERE r.workspace_id=? AND r.status<>'trash' ORDER BY r.created_at,r.id`).bind(since, ws).all<{ id: string; name: string; active: number; runs: number }>(),
  ])
  const items = new Map<string, Item[]>()
  const add = (family: string, item: Item) => items.set(family, [...(items.get(family) ?? []), item])
  for (const t of triggers.results) {
    const system = t.kind === 'external_trigger' ? (JSON.parse(t.config) as { system_kind?: string }).system_kind : undefined
    const family = system === 'system_opt_in' || system === 'system_opt_out' ? 'confirmations' : TYPE_FAMILY[triggerTypeOf(t.kind, t.widget_type)]
    if (!family) continue
    const type = triggerTypeOf(t.kind, t.widget_type)
    const label = system === 'system_opt_in' ? 'Confirmação de inscrição' : system === 'system_opt_out' ? 'Confirmação de descadastro' : triggerTypeLabel[type]
    const typeChannel = t.channel_type ? `${label} · ${channelLabel[t.channel_type] ?? t.channel_type}` : label
    add(family, { id: t.id, name: t.name, type_channel: typeChannel, type_key: typeChannelKey(type, t.channel_type), type_code: widgetTypeCode(type, t.channel_type), active: t.status === 'active' && t.automation_status === 'live', runs_30d: Number(t.runs),
      target: family === 'basic' || family === 'confirmations' ? { kind: 'screen', screen: 'basic' } : { kind: 'automation', automation_id: t.automation_id, automation_name: t.automation_name } })
  }
  const clicks = new Map(firings.results.map(f => [`${f.connection_id}|${f.kind}|${f.item_id}`, Number(f.n)]))
  for (const s of surfaces.results) {
    const config = JSON.parse(s.published ?? s.draft) as { items?: { id: string; title: string }[] }
    for (const item of config.items ?? []) {
      add('surfaces', { id: `${s.connection_id}:${s.kind}:${item.id}`, name: item.title, active: s.published !== null && (JSON.parse(s.published) as { enabled?: boolean }).enabled === true,
        type_channel: `${s.kind === 'main_menu' ? 'Menu principal' : 'Iniciador de conversa'} · ${channelLabel[s.channel_type] ?? s.channel_type}`,
        runs_30d: clicks.get(`${s.connection_id}|${s.kind}|${item.id}`) ?? 0, target: { kind: 'screen', screen: 'basic' } })
    }
  }
  for (const r of rules.results) add('rules', { id: r.id, name: r.name, type_channel: 'Regra', active: r.active === 1, runs_30d: Number(r.runs), target: { kind: 'screen', screen: 'rules' } })
  const families: Family[] = FAMILIES.map(([id, label]) => {
    const list = items.get(id) ?? []
    return { id, label, active: list.filter(i => i.active).length, total: list.length,
      runs_30d: list.reduce((sum, i) => sum + i.runs_30d, 0), items: list.slice(0, MAX_ITEMS) }
  })
  return c.json({ families })
})


/** Página própria do gatilho (ex.: menção em story): dados básicos e a automação que ele dispara hoje. */
triggersOverview.get('/triggers/:id', async c => {
  authorize(c.var.principal, 'automation:read')
  const row = await c.env.DB.prepare(`SELECT t.id,t.name,t.kind,t.widget_type,t.status,t.automation_id,a.name AS automation_name,t.channel_id,coalesce(json_extract(t.config,'$.opt_in_status'),'subscribe') AS opt_in_status,json_extract(t.config,'$.follow_up') AS follow_up,coalesce(ch.display_name,ch.type) AS channel_name
    FROM triggers t JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id LEFT JOIN channels ch ON ch.workspace_id=t.workspace_id AND ch.id=t.channel_id
    WHERE t.workspace_id=? AND t.id=?`).bind(c.var.principal.workspaceId, z.string().min(1).max(128).parse(c.req.param('id'))).first<{ kind: string; widget_type: string | null }>()
  if (!row) return c.json({ error: 'Gatilho não encontrado.' }, 404)
  return c.json({ ...row, type: triggerTypeOf(row.kind, row.widget_type), type_label: triggerTypeLabel[triggerTypeOf(row.kind, row.widget_type)] })
})
/** A trava vale para a automação a que o gatilho pertence hoje (qualquer mudança nele é uma edição dela). */
async function assertTriggerUnlocked(c: Context<{ Bindings: Env; Variables: AuthVariables }>, triggerId: string) {
  const owner = await c.env.DB.prepare('SELECT automation_id FROM triggers WHERE workspace_id=? AND id=?').bind(c.var.principal.workspaceId, triggerId).first<string>('automation_id')
  if (owner) await assertUnlocked(c.env.DB, c.var.principal.workspaceId, owner, 'edit', c.var.principal)
}
/** Substituir: o gatilho passa a disparar outra automação publicada (entra pelo primeiro passo de gatilho dela); histórico e frequência ficam. */
triggersOverview.post('/triggers/:id/replace', async c => {
  authorize(c.var.principal, 'edit')
  const ws = c.var.principal.workspaceId, id = z.string().min(1).max(128).parse(c.req.param('id'))
  const { automation_id } = triggerReplaceSchema.parse(await c.req.json().catch(() => ({})))
  await assertTriggerUnlocked(c, id)
  await assertUnlocked(c.env.DB, ws, automation_id, 'edit', c.var.principal)   // o destino também ganha um gatilho
  const target = await c.env.DB.prepare(`SELECT v.graph FROM automations a JOIN automation_versions v ON v.workspace_id=a.workspace_id AND v.id=a.published_version_id
    WHERE a.workspace_id=? AND a.id=? AND a.deleted_at IS NULL`).bind(ws, automation_id).first<string>('graph')
  if (!target) return c.json({ error: 'Escolha uma automação publicada.' }, 409)
  const start = (JSON.parse(target) as { nodes: { id: string; type: string }[] }).nodes.find(n => n.type === 'trigger')
  if (!start) return c.json({ error: 'A automação escolhida não tem passo de gatilho.' }, 409)
  const r = await c.env.DB.prepare("UPDATE triggers SET automation_id=?,config=json_set(config,'$.node_id',?),updated_at=? WHERE workspace_id=? AND id=?")
    .bind(automation_id, start.id, Date.now(), ws, id).run()
  if (!r.meta.changes) return c.json({ error: 'Gatilho não encontrado.' }, 404)
  return c.json({ id, automation_id, node_id: start.id })
})

/** opt_in_status do gatilho: subscribe (padrão) ou do_not_send (quem entra por ele fica fora das transmissões até se inscrever). */
triggersOverview.put('/triggers/:id/opt-in-status', async c => {
  authorize(c.var.principal, 'edit')
  const { opt_in_status } = triggerOptInStatusSchema.parse(await c.req.json().catch(() => ({})))
  await assertTriggerUnlocked(c, z.string().min(1).max(128).parse(c.req.param('id')))
  const r = await c.env.DB.prepare("UPDATE triggers SET config=json_set(config,'$.opt_in_status',?),updated_at=? WHERE workspace_id=? AND id=?")
    .bind(opt_in_status, Date.now(), c.var.principal.workspaceId, z.string().min(1).max(128).parse(c.req.param('id'))).run()
  if (!r.meta.changes) return c.json({ error: 'Gatilho não encontrado.' }, 404)
  return c.json({ opt_in_status })
})

/** Follow-up do gatilho: depois de X minutos sem resposta do contato, começa a automação escolhida. null desliga. */
triggersOverview.put('/triggers/:id/follow-up', async c => {
  authorize(c.var.principal, 'edit')
  const input = triggerFollowUpSchema.parse(await c.req.json().catch(() => ({})))
  const ws = c.var.principal.workspaceId
  await assertTriggerUnlocked(c, z.string().min(1).max(128).parse(c.req.param('id')))
  if (input.follow_up && !await c.env.DB.prepare("SELECT 1 FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL").bind(ws, input.follow_up.automation_id).first()) return c.json({ error: 'Automação não encontrada.' }, 404)
  const r = await c.env.DB.prepare(input.follow_up ? "UPDATE triggers SET config=json_set(config,'$.follow_up',json(?)),updated_at=? WHERE workspace_id=? AND id=?" : "UPDATE triggers SET config=json_remove(config,'$.follow_up'),updated_at=? WHERE workspace_id=? AND id=?")
    .bind(...(input.follow_up ? [JSON.stringify(input.follow_up)] : []), Date.now(), ws, z.string().min(1).max(128).parse(c.req.param('id'))).run()
  if (!r.meta.changes) return c.json({ error: 'Gatilho não encontrado.' }, 404)
  return c.json(input)
})
