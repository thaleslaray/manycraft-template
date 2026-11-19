import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize, can } from './permissions'
import { connectionColumns, connectionFromRow, type ConnectionRow } from './channels/core/connection'
import { connectionRuntime } from './channels/core/runtime'
import { assertPublishable } from './channels/core/publish-check'
import type { ChannelProfile } from './channels/contract'

export const conversationSurfaces = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const kinds = z.enum(['conversation_starters', 'main_menu'])
export type SurfaceKind = z.infer<typeof kinds>
export const surfaceConfigSchema = z.object({ enabled: z.boolean(), items: z.array(z.object({
  id: z.string().regex(/^[\w-]{1,64}$/), title: z.string().trim().min(1).max(80), automation_id: z.string().min(1).max(128),
}).strict()).max(20) }).strict().refine(input => new Set(input.items.map(item => item.id)).size === input.items.length)
export type SurfaceConfig = Omit<z.infer<typeof surfaceConfigSchema>, 'items'> & { items: (z.infer<typeof surfaceConfigSchema>['items'][number] & { payload?: string })[] }
export type SurfaceRow = { draft: string; published: string | null; published_at: number | null; publishing: number }
export function surfaceCapability(profile: ChannelProfile, kind: SurfaceKind) {
  return kind === 'conversation_starters' ? profile.conversationStarters : profile.mainMenu
}
const empty = () => ({ enabled: false, items: [] })
const key = '/basic/:connection/surfaces/:kind'

async function connection(db: D1Database, ws: string, id: string) {
  const row = await db.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL`)
    .bind(ws, id).first<ConnectionRow>()
  if (!row) throw new HTTPException(404, { message: 'Conexão não encontrada.' })
  return connectionFromRow(row)
}
async function read(db: D1Database, ws: string, id: string, kind: SurfaceKind) {
  const [row, clicks] = await Promise.all([
    db.prepare('SELECT draft,published,published_at,publishing FROM conversation_surfaces WHERE workspace_id=? AND connection_id=? AND kind=?')
      .bind(ws, id, kind).first<SurfaceRow>(),
    db.prepare('SELECT item_id,count(*) clicks FROM surface_firings WHERE workspace_id=? AND connection_id=? AND kind=? GROUP BY item_id')
      .bind(ws, id, kind).all<{ item_id: string; clicks: number }>(),
  ])
  return { draft: row ? JSON.parse(row.draft) as SurfaceConfig : empty(), published: row?.published ? JSON.parse(row.published) as SurfaceConfig : null,
    published_at: row?.published_at ?? null, publishing: !!row?.publishing, clicks: Object.fromEntries(clicks.results.map(item => [item.item_id, item.clicks])) }
}
function validate(profile: ChannelProfile, kind: SurfaceKind, config: SurfaceConfig) {
  const cap = surfaceCapability(profile, kind)
  if (!cap) throw new HTTPException(400, { message: 'Este recurso não está disponível nesta conexão.' })
  if (config.items.length > cap.maxItems || config.items.some(item => item.title.length > cap.titleMax)) {
    throw new HTTPException(400, { message: `Use até ${cap.maxItems} itens com títulos de até ${cap.titleMax} caracteres.` })
  }
  if (config.enabled && !config.items.length) throw new HTTPException(400, { message: 'Adicione um item antes de ativar.' })
}
async function validateAutomations(db: D1Database, ws: string, config: SurfaceConfig, publishing = false) {
  for (const item of config.items) {
    const automation = await db.prepare('SELECT status,published_version_id,deleted_at FROM automations WHERE workspace_id=? AND id=?')
      .bind(ws, item.automation_id).first<{ status: string; published_version_id: string | null; deleted_at: number | null }>()
    // Desativar continua possível após exclusão lógica, sem aceitar vínculos de outro workspace.
    if (!automation || config.enabled && automation.deleted_at !== null) throw new HTTPException(404, { message: 'Automação não encontrada.' })
    if (publishing && config.enabled && (automation.status !== 'live' || !automation.published_version_id)) {
      throw new HTTPException(409, { message: 'Publique e retome as automações ligadas antes de publicar esta configuração.' })
    }
  }
}
conversationSurfaces.get(key, async c => {
  authorize(c.var.principal, 'automation:read')
  const ws = c.var.principal.workspaceId, id = c.req.param('connection'), kind = kinds.parse(c.req.param('kind'))
  // A leitura sai junto com a checagem da conexão (uma onda); a checagem continua barrando antes de qualquer dado sair.
  const loaded = read(c.env.DB, ws, id, kind)
  loaded.catch(() => undefined)
  await connection(c.env.DB, ws, id)
  return c.json({ ...await loaded, can_edit: can(c.var.principal, 'edit', { workspace_id: ws }) })
})
conversationSurfaces.put(key, async c => {
  authorize(c.var.principal, 'edit')
  const ws = c.var.principal.workspaceId, id = c.req.param('connection'), kind = kinds.parse(c.req.param('kind'))
  const input = surfaceConfigSchema.parse(await c.req.json().catch(() => null))
  const conn = await connection(c.env.DB, ws, id)
  validate(conn.profile, kind, input)
  await validateAutomations(c.env.DB, ws, input)
  const result = await c.env.DB.prepare(`INSERT INTO conversation_surfaces(workspace_id,connection_id,kind,draft) VALUES (?,?,?,?)
    ON CONFLICT(workspace_id,connection_id,kind) DO UPDATE SET draft=excluded.draft,publishing=0 WHERE publishing=0 OR publishing<?`)
    .bind(ws, id, kind, JSON.stringify(input), Date.now() - 120_000).run()
  if (!result.meta.changes) throw new HTTPException(409, { message: 'Aguarde a publicação em andamento.' })
  return c.json({ ...await read(c.env.DB, ws, id, kind), can_edit: can(c.var.principal, 'edit', { workspace_id: ws }) })
})
conversationSurfaces.post(`${key}/publish`, async c => {
  authorize(c.var.principal, 'edit')
  const ws = c.var.principal.workspaceId, id = c.req.param('connection'), kind = kinds.parse(c.req.param('kind'))
  const conn = await connection(c.env.DB, ws, id)
  const lease = Date.now()
  const claim = await c.env.DB.prepare('UPDATE conversation_surfaces SET publishing=? WHERE workspace_id=? AND connection_id=? AND kind=? AND (publishing=0 OR publishing<?) RETURNING draft,published')
    .bind(lease, ws, id, kind, lease - 120_000).first<{ draft: string; published: string | null }>()
  if (!claim) throw new HTTPException(409, { message: 'Salve o rascunho e aguarde qualquer publicação em andamento.' })
  try {
    const config = surfaceConfigSchema.parse(JSON.parse(claim.draft))
    validate(conn.profile, kind, config)
    await validateAutomations(c.env.DB, ws, config, true)
    if (config.enabled) {
      for (const automationId of new Set(config.items.map(item => item.automation_id))) {
        await assertPublishable(c.env, ws, automationId, id)
      }
    }
    const rt = await connectionRuntime(c.env, ws, id, { requireConnected: true })
    if (!rt.provider?.configureSurface) throw new HTTPException(400, { message: 'O provedor não publica este recurso.' })
    const old: SurfaceConfig | null = claim.published ? JSON.parse(claim.published) : null
    const published = { ...config, items: config.items.map(item => ({ ...item,
      payload: old?.items.find(prior => prior.id === item.id && prior.automation_id === item.automation_id)?.payload ?? `s:${crypto.randomUUID()}`,
    })) }
    try {
      await rt.provider.configureSurface({ connection: rt.connection, credentials: await rt.credentials(), fetch: rt.fetch },
        { kind, enabled: config.enabled, items: published.items.map(({ title, payload }) => ({ title, payload })) })
    } catch { throw new HTTPException(502, { message: 'O provedor não confirmou a publicação. O rascunho foi mantido; tente novamente.' }) }
    await c.env.DB.prepare('UPDATE conversation_surfaces SET published=?,published_at=? WHERE workspace_id=? AND connection_id=? AND kind=? AND publishing=?')
      .bind(JSON.stringify(published), Date.now(), ws, id, kind, lease).run()
  } finally {
    await c.env.DB.prepare('UPDATE conversation_surfaces SET publishing=0 WHERE workspace_id=? AND connection_id=? AND kind=? AND publishing=?').bind(ws, id, kind, lease).run()
  }
  return c.json({ ...await read(c.env.DB, ws, id, kind), can_edit: can(c.var.principal, 'edit', { workspace_id: ws }) })
})
