import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { limit } from './security'
import { createField, setFieldValue } from './db/fields'
import { createTag } from './db/tags'
import { validateFieldValue } from './db/fields'
import { RepositoryError } from './db/shared'
import { dynamicResponseSchema, fullContactData } from './flow/dynamic-block'
import { ensureWorkflow, hasFlow } from './flow/dispatch'
import { sendDynamicContent } from './flow/content-run'
import { apiOptInFlags } from './channels/consent'
import { triggerTypeOf } from '../../shared/trigger-types'
import { newIdentityConsent } from './channels/core/consent'

/**
 * API pública por chave: `Authorization: Bearer <espaço>:<segredo>`. Toda resposta vem no envelope
 * `{ status: 'success', data }` ou `{ status: 'error', message }`. Tags e campos aceitam id ou nome.
 */
type PublicEnv = { Bindings: Env; Variables: { workspace: string } }
export const publicApi = new Hono<PublicEnv>()
const id = z.string().min(1).max(128)
const fieldTypes = ['text', 'number', 'date', 'datetime', 'boolean'] as const

async function sha256(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('')
}
const ok = (c: Context, data: unknown = null, status: 200 | 201 = 200) => c.json({ status: 'success', data }, status)

publicApi.onError((error, c) => {
  const status = error instanceof HTTPException ? error.status : error instanceof RepositoryError ? error.status
    : error instanceof z.ZodError ? 400 : 500
  const message = error instanceof z.ZodError ? 'Parâmetros inválidos: ' + [...new Set(error.issues.map(i => i.path.join('.') || i.message))].join(', ')
    : status === 500 ? 'Erro interno.' : error.message
  return c.json({ status: 'error', message }, status as 400)
})
publicApi.notFound(c => c.json({ status: 'error', message: 'Rota não encontrada.' }, 404))

publicApi.use('*', async (c, next) => {
  const match = /^Bearer\s+([^:\s]+):(\S+)$/.exec(c.req.header('authorization') ?? '')
  if (!match) throw new HTTPException(401, { message: 'Envie Authorization: Bearer <espaço>:<chave>.' })
  // Chave de perfil: `Bearer perfil:<chave>` e o espaço no cabeçalho x-workspace (a pessoa precisa poder editar nele).
  if (match[1] === 'perfil') {
    const ws = z.string().min(1).max(128).safeParse(c.req.header('x-workspace'))
    if (!ws.success) throw new HTTPException(400, { message: 'Com a chave de perfil, informe o espaço no cabeçalho x-workspace.' })
    const key = await c.env.DB.prepare(`SELECT k.id FROM user_api_keys k JOIN workspace_members m ON m.user_id=k.user_id AND m.workspace_id=? AND m.role IN ('owner','administrator','editor')
      WHERE k.hash=? AND k.revoked_at IS NULL`).bind(ws.data, await sha256(match[2])).first<{ id: string }>()
    if (!key) throw new HTTPException(401, { message: 'Chave inválida, revogada ou sem acesso a este espaço.' })
    c.set('workspace', ws.data)
    await c.env.DB.prepare('UPDATE user_api_keys SET last_used_at=? WHERE id=?').bind(Date.now(), key.id).run()
    return next()
  }
  const key = await c.env.DB.prepare('SELECT id FROM api_keys WHERE workspace_id=? AND hash=? AND revoked_at IS NULL')
    .bind(match[1], await sha256(match[2])).first<{ id: string }>()
  if (!key) throw new HTTPException(401, { message: 'Chave inválida ou revogada.' })
  c.set('workspace', match[1])
  await c.env.DB.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').bind(Date.now(), key.id).run()
  await next()
})
async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown
  try { raw = await c.req.json() } catch { throw new HTTPException(400, { message: 'JSON inválido.' }) }
  return schema.parse(raw)
}

async function contactOr404(c: Context<PublicEnv>, contactId: string) {
  const data = await fullContactData(c.env.DB, c.var.workspace, contactId)
  if (!data) throw new HTTPException(404, { message: 'Contato não encontrado.' })
  return data
}
async function tagId(c: Context<PublicEnv>, ref: { tag_id?: string; tag_name?: string }) {
  const row = await c.env.DB.prepare(`SELECT id FROM tags WHERE workspace_id=? AND ${ref.tag_id ? 'id' : 'name'}=? AND archived=0`)
    .bind(c.var.workspace, ref.tag_id ?? ref.tag_name).first<{ id: string }>()
  if (!row) throw new HTTPException(404, { message: 'Tag não encontrada.' })
  return row.id
}
async function fieldRef(c: Context<PublicEnv>, scope: 'contact' | 'bot', ref: { field_id?: string; field_name?: string }) {
  const row = await c.env.DB.prepare(`SELECT id,type FROM custom_fields WHERE workspace_id=? AND scope=? AND ${ref.field_id ? 'id' : 'name'}=? AND archived=0`)
    .bind(c.var.workspace, scope, ref.field_id ?? ref.field_name).first<{ id: string; type: string }>()
  if (!row) throw new HTTPException(404, { message: scope === 'bot' ? 'Campo do bot não encontrado.' : 'Campo não encontrado.' })
  return row
}

// ───────── Schemas dos corpos (os mesmos objetos usados pelas rotas e pela documentação) ─────────
export const v1CreateTagSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict()
export const v1CreateCustomFieldSchema = z.object({ caption: z.string().trim().min(1).max(120), type: z.enum(fieldTypes), description: z.string().max(2000).optional() }).strict()
export const v1CreateBotFieldSchema = z.object({ name: z.string().trim().min(1).max(120), type: z.enum(fieldTypes), description: z.string().max(2000).optional(), value: z.unknown().optional() }).strict()
export const v1SetBotFieldSchema = z.object({ field_id: id }).extend({ field_value: z.unknown() }).strict()
export const v1SetBotFieldByNameSchema = z.object({ field_name: z.string().min(1).max(120) }).extend({ field_value: z.unknown() }).strict()
const optInFlags = Object.fromEntries(Object.keys(apiOptInFlags).map(flag => [flag, z.boolean().optional()])) as Record<keyof typeof apiOptInFlags, z.ZodOptional<z.ZodBoolean>>
export const v1CreateSubscriberSchema = z.object({
  first_name: z.string().trim().max(60).optional(), last_name: z.string().trim().max(60).optional(),
  phone: z.string().trim().regex(/^\+?[\d().\s-]{8,20}$/).transform(v => v.replace(/\D/g, '')).optional(), email: z.email().max(254).transform(v => v.toLowerCase()).optional(),
  ...optInFlags, consent_phrase: z.string().trim().min(1).max(500).optional(),
}).strict()
/** addTag, addTagByName, removeTag e removeTagByName aceitam a tag por id ou por nome. */
export const v1TagRefSchema = z.union([z.object({ subscriber_id: id, tag_id: id }).strict(), z.object({ subscriber_id: id, tag_name: z.string().min(1).max(120) }).strict()])
export const v1SetCustomFieldSchema = z.object({ field_id: id }).extend({ subscriber_id: id, field_value: z.unknown() }).strict()
export const v1SetCustomFieldByNameSchema = z.object({ field_name: z.string().min(1).max(120) }).extend({ subscriber_id: id, field_value: z.unknown() }).strict()
export const v1SendFlowSchema = z.object({ subscriber_id: id, flow_ns: id }).strict()
export const v1FireTriggerSchema = z.object({ subscriber_id: id, trigger_name: z.string().regex(/^[a-z0-9_]{1,64}$/), context: z.record(z.string().max(64), z.union([z.string().max(2000), z.number(), z.boolean()])).default({}) }).strict()
export const v1SendContentSchema = z.object({ subscriber_id: id, data: dynamicResponseSchema }).strict()
export const v1SendContentByUserRefSchema = z.object({ user_ref: z.string().min(1).max(256), channel_id: id, data: dynamicResponseSchema }).strict()

// ───────── Espaço (page) ─────────
publicApi.get('/page/getInfo', async c => ok(c, await c.env.DB.prepare('SELECT id,name,timezone FROM workspaces WHERE id=?').bind(c.var.workspace).first()))
publicApi.get('/page/getTags', async c => ok(c, (await c.env.DB.prepare('SELECT id,name FROM tags WHERE workspace_id=? AND archived=0 ORDER BY name').bind(c.var.workspace).all()).results))
publicApi.post('/page/createTag', async c => {
  const input = await body(c, v1CreateTagSchema)
  const tag = await createTag(c.env.DB, c.var.workspace, input.name)
  return ok(c, { id: tag.id, name: tag.name }, 201)
})
for (const [path, scope] of [['getCustomFields', 'contact'], ['getBotFields', 'bot']] as const) {
  publicApi.get(`/page/${path}`, async c => {
    const rows = await c.env.DB.prepare('SELECT id,name,type,description,bot_value FROM custom_fields WHERE workspace_id=? AND scope=? AND archived=0 ORDER BY name')
      .bind(c.var.workspace, scope).all<{ id: string; name: string; type: string; description: string | null; bot_value: string | null }>()
    return ok(c, rows.results.map(({ bot_value, ...row }) => scope === 'bot' ? { ...row, value: bot_value == null ? null : JSON.parse(bot_value) as unknown } : row))
  })
}
publicApi.post('/page/createCustomField', async c => {
  const input = await body(c, v1CreateCustomFieldSchema)
  const field = await createField(c.env.DB, c.var.workspace, { name: input.caption, type: input.type, description: input.description ?? null })
  return ok(c, { id: field.id, name: field.name, type: field.type }, 201)
})
publicApi.post('/page/createBotField', async c => {
  const input = await body(c, v1CreateBotFieldSchema)
  const field = await createField(c.env.DB, c.var.workspace, { name: input.name, type: input.type, scope: 'bot', description: input.description ?? null, bot_value: input.value ?? null })
  return ok(c, { id: field.id, name: field.name, type: field.type }, 201)
})
for (const [path, schema] of [['setBotField', v1SetBotFieldSchema], ['setBotFieldByName', v1SetBotFieldByNameSchema]] as const) {
  publicApi.post(`/page/${path}`, async c => {
    const input = await body(c, schema)
    const field = await fieldRef(c, 'bot', input)
    if (input.field_value != null) {
      try { validateFieldValue(field.type, input.field_value) } catch (error) { throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Valor inválido.' }) }
    }
    await c.env.DB.prepare('UPDATE custom_fields SET bot_value=?,updated_at=? WHERE workspace_id=? AND id=?')
      .bind(input.field_value == null ? null : JSON.stringify(input.field_value), Date.now(), c.var.workspace, field.id).run()
    return ok(c)
  })
}
publicApi.get('/page/getFlows', async c => {
  const rows = await c.env.DB.prepare(`SELECT id AS ns,name,status,published_version_id IS NOT NULL AS published FROM automations
    WHERE workspace_id=? AND deleted_at IS NULL ORDER BY name,id`).bind(c.var.workspace).all<{ ns: string; name: string; status: string; published: number }>()
  return ok(c, rows.results.map(row => ({ ...row, published: !!row.published })))
})
publicApi.get('/page/getGrowthTools', async c => {
  const rows = await c.env.DB.prepare(`SELECT id,name,kind,widget_type,status,automation_id FROM triggers WHERE workspace_id=? ORDER BY name,id`)
    .bind(c.var.workspace).all<{ id: string; name: string | null; kind: string; widget_type: string | null; status: string; automation_id: string | null }>()
  return ok(c, rows.results.map(({ kind, widget_type, ...row }) => ({ ...row, type: triggerTypeOf(kind, widget_type) })))
})

// ───────── Contatos (subscriber) ─────────
export const v1GetInfoQuerySchema = z.object({ subscriber_id: id.describe('Id do contato.') })
export const v1UserRefQuerySchema = z.object({ user_ref: z.string().min(1).max(256).describe('Identidade do contato no canal (o id que o canal manda).') })
export const v1FindByNameQuerySchema = z.object({ name: z.string().trim().min(1).max(120).describe('Nome completo (primeiro e último), sem diferença de maiúsculas.') })
export const v1FindByCustomFieldQuerySchema = z.object({ field_id: id.describe('Id do campo do contato.'), field_value: z.string().max(2000).describe('Valor procurado, como texto.') }).strict()
publicApi.get('/subscriber/getInfo', async c => ok(c, await contactOr404(c, v1GetInfoQuerySchema.parse({ subscriber_id: c.req.query('subscriber_id') }).subscriber_id)))
/** user_ref: a identidade do contato no canal (o id que o canal manda); serve antes de o sistema conhecer o contato por outro dado. */
publicApi.get('/subscriber/getInfoByUserRef', async c => {
  const ref = v1UserRefQuerySchema.parse({ user_ref: c.req.query('user_ref') }).user_ref
  const row = await c.env.DB.prepare('SELECT contact_id FROM contact_channels WHERE workspace_id=? AND external_user_id=? ORDER BY updated_at DESC LIMIT 1').bind(c.var.workspace, ref).first<string>('contact_id')
  if (!row) throw new HTTPException(404, { message: 'Contato não encontrado.' })
  return ok(c, await contactOr404(c, row))
})
publicApi.get('/subscriber/findByName', async c => {
  const name = v1FindByNameQuerySchema.parse({ name: c.req.query('name') }).name
  const rows = await c.env.DB.prepare(`SELECT id FROM contacts WHERE workspace_id=? AND lower(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')))=lower(?) ORDER BY id LIMIT 100`)
    .bind(c.var.workspace, name).all<{ id: string }>()
  return ok(c, await Promise.all(rows.results.map(row => contactOr404(c, row.id))))
})
publicApi.get('/subscriber/findByCustomField', async c => {
  const query = v1FindByCustomFieldQuerySchema.parse(c.req.query())
  const field = await fieldRef(c, 'contact', query)
  // O valor chega como texto na URL: comparamos com o JSON guardado já convertido para o tipo do campo.
  const value = field.type === 'number' ? Number(query.field_value) : field.type === 'boolean' ? query.field_value === 'true' : query.field_value
  const rows = await c.env.DB.prepare('SELECT contact_id AS id FROM contact_field_values WHERE workspace_id=? AND field_id=? AND value=? ORDER BY contact_id LIMIT 100')
    .bind(c.var.workspace, field.id, JSON.stringify(value)).all<{ id: string }>()
  return ok(c, await Promise.all(rows.results.map(row => contactOr404(c, row.id))))
})
publicApi.post('/subscriber/createSubscriber', async c => {
  const input = await body(c, v1CreateSubscriberSchema)
  if (!input.phone && !input.email) throw new HTTPException(400, { message: 'Informe phone ou email.' })
  const optIns = (Object.entries(apiOptInFlags) as [keyof typeof apiOptInFlags, string][]).filter(([flag]) => input[flag]).map(([, channel]) => channel)
  if (optIns.length && !input.consent_phrase) throw new HTTPException(400, { message: 'consent_phrase é obrigatório quando há opt-in.' })
  if (optIns.some(channel => !(channel === apiOptInFlags.has_opt_in_email ? input.email : input.phone))) throw new HTTPException(400, { message: 'O opt-in exige o dado do canal (email ou phone).' })
  const workspace = c.var.workspace, contactId = crypto.randomUUID()
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO contacts(id,workspace_id,first_name,last_name,email,phone,optin_source) VALUES (?,?,?,?,?,?,'api')`)
        .bind(contactId, workspace, input.first_name || null, input.last_name || null, input.email ?? null, input.phone ?? null),
      ...optIns.map(channel => c.env.DB.prepare('INSERT INTO contact_consents (id,workspace_id,contact_id,channel_type,value,phrase,source) VALUES (?,?,?,?,?,?,?)')
        .bind(`consent-api-${contactId}-${channel}`, workspace, contactId, channel, channel === apiOptInFlags.has_opt_in_email ? input.email : input.phone, input.consent_phrase, 'api')),
    ])
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: contacts\./.test(error.message)) throw new HTTPException(409, { message: 'Já existe um contato com este telefone ou e-mail.' })
    throw error
  }
  return ok(c, await contactOr404(c, contactId), 201)
})
for (const [path, add] of [['addTag', true], ['addTagByName', true], ['removeTag', false], ['removeTagByName', false]] as const) {
  publicApi.post(`/subscriber/${path}`, async c => {
    const input = await body(c, v1TagRefSchema)
    await contactOr404(c, input.subscriber_id)
    const tag = await tagId(c, input)
    await c.env.DB.prepare(add ? 'INSERT INTO contact_tags (workspace_id,contact_id,tag_id) VALUES (?,?,?) ON CONFLICT DO NOTHING'
      : 'DELETE FROM contact_tags WHERE workspace_id=? AND contact_id=? AND tag_id=?').bind(c.var.workspace, input.subscriber_id, tag).run()
    return ok(c)
  })
}
for (const [path, schema] of [['setCustomField', v1SetCustomFieldSchema], ['setCustomFieldByName', v1SetCustomFieldByNameSchema]] as const) {
  publicApi.post(`/subscriber/${path}`, async c => {
    const input = await body(c, schema)
    await contactOr404(c, input.subscriber_id)
    const field = await fieldRef(c, 'contact', input)
    if (input.field_value == null) await c.env.DB.prepare('DELETE FROM contact_field_values WHERE workspace_id=? AND contact_id=? AND field_id=?').bind(c.var.workspace, input.subscriber_id, field.id).run()
    else await setFieldValue(c.env.DB, c.var.workspace, input.subscriber_id, field.id, input.field_value)
    return ok(c)
  })
}

// ───────── Envio (sending) ─────────
/** Teto de execuções iniciadas por esta API para o mesmo contato e a mesma automação: uma automação que chama a própria API não se reinicia sem fim. */
const limitStarts = (c: Context<PublicEnv>, contactId: string, automationId: string) =>
  limit(c.env, `public-start:${c.var.workspace}:${contactId}:${automationId}`, 30, 60_000)
publicApi.post('/sending/sendFlow', async c => {
  const input = await body(c, v1SendFlowSchema)
  if (!hasFlow(c.env)) throw new HTTPException(503, { message: 'O executor de automações não está disponível.' })
  // A automação sai pela conexão mais recente do contato.
  const link = await c.env.DB.prepare(`SELECT cc.channel_id FROM contact_channels cc JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
    WHERE cc.workspace_id=? AND cc.contact_id=? AND ch.archived_at IS NULL ORDER BY cc.updated_at DESC,cc.id LIMIT 1`).bind(c.var.workspace, input.subscriber_id).first<{ channel_id: string }>()
  if (!link) throw new HTTPException(409, { message: 'O contato não tem conexão para receber a automação.' })
  await limitStarts(c, input.subscriber_id, input.flow_ns)
  const runId = `api-${crypto.randomUUID()}`
  const created = await c.env.DB.prepare(`INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id)
    SELECT ?,?,?,a.published_version_id,? FROM automations a WHERE a.workspace_id=? AND a.id=? AND a.status='live' AND a.deleted_at IS NULL AND a.published_version_id IS NOT NULL`)
    .bind(runId, c.var.workspace, input.subscriber_id, link.channel_id, c.var.workspace, input.flow_ns).run()
  if (!created.meta.changes) throw new HTTPException(409, { message: 'Escolha uma automação publicada e ligada.' })
  await ensureWorkflow(c.env, runId)
  return ok(c, { run_id: runId })
})

/** Entrada externa (Dev Program): dispara a automação ligada ao trigger_name; o contexto preenche campos de texto de mesmo nome. */
publicApi.post('/triggers/fire', async c => {
  const input = await body(c, v1FireTriggerSchema)
  if (!hasFlow(c.env)) throw new HTTPException(503, { message: 'O executor de automações não está disponível.' })
  await contactOr404(c, input.subscriber_id)
  const trigger = await c.env.DB.prepare(`SELECT t.id,t.automation_id,t.config,a.published_version_id FROM triggers t JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
    WHERE t.workspace_id=? AND t.kind='external_trigger' AND json_extract(t.config,'$.trigger_name')=? AND t.status='active' AND a.status='live' AND a.deleted_at IS NULL AND a.published_version_id IS NOT NULL`)
    .bind(c.var.workspace, input.trigger_name).first<{ id: string; automation_id: string; config: string; published_version_id: string }>()
  if (!trigger) throw new HTTPException(404, { message: 'Nenhuma entrada externa ativa com este nome.' })
  const link = await c.env.DB.prepare(`SELECT cc.channel_id FROM contact_channels cc JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
    WHERE cc.workspace_id=? AND cc.contact_id=? AND ch.archived_at IS NULL ORDER BY cc.updated_at DESC,cc.id LIMIT 1`).bind(c.var.workspace, input.subscriber_id).first<{ channel_id: string }>()
  if (!link) throw new HTTPException(409, { message: 'O contato não tem conexão para receber a automação.' })
  await limitStarts(c, input.subscriber_id, trigger.automation_id)
  const statements = Object.entries(input.context).map(([name, value]) => c.env.DB.prepare(`INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value)
    SELECT ?,?,id,? FROM custom_fields WHERE workspace_id=? AND name=? AND scope='contact' AND type='text' AND archived=0
    ON CONFLICT(contact_id,field_id) DO UPDATE SET value=excluded.value,updated_at=?`).bind(c.var.workspace, input.subscriber_id, JSON.stringify(String(value)), c.var.workspace, name, Date.now()))
  const runId = `api-${crypto.randomUUID()}`, start = (JSON.parse(trigger.config) as { node_id?: string }).node_id ?? null
  await c.env.DB.batch([...statements, c.env.DB.prepare(`INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,trigger_id,channel_id,start_node_id) VALUES (?,?,?,?,?,?,?)`)
    .bind(runId, c.var.workspace, input.subscriber_id, trigger.published_version_id, trigger.id, link.channel_id, start)])
  await ensureWorkflow(c.env, runId)
  return ok(c, { run_id: runId })
})

/** sendContent: conteúdo no formato do bloco dinâmico (v2) vai ao contato por uma automação interna escondida. */
publicApi.post('/sending/sendContent', async c => {
  const input = await body(c, v1SendContentSchema)
  if (!hasFlow(c.env)) throw new HTTPException(503, { message: 'O executor de automações não está disponível.' })
  await contactOr404(c, input.subscriber_id)
  const link = await c.env.DB.prepare(`SELECT cc.channel_id FROM contact_channels cc JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
    WHERE cc.workspace_id=? AND cc.contact_id=? AND ch.archived_at IS NULL ORDER BY cc.updated_at DESC,cc.id LIMIT 1`).bind(c.var.workspace, input.subscriber_id).first<{ channel_id: string }>()
  if (!link) throw new HTTPException(409, { message: 'O contato não tem conexão para receber a mensagem.' })
  const runId = await sendDynamicContent(c.env, c.var.workspace, input.subscriber_id, link.channel_id, input.data)
  return ok(c, { run_id: runId })
})

// ───────── Chaves (painel, com sessão) ─────────
export const apiKeys = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
apiKeys.get('/api-keys', async c => {
  authorize(c.var.principal, 'team')
  return c.json(await c.env.DB.prepare('SELECT id,last4,created_at,last_used_at FROM api_keys WHERE workspace_id=? AND revoked_at IS NULL ORDER BY created_at DESC')
    .bind(c.var.principal.workspaceId).first() ?? null)
})
/** Gera uma chave nova e revoga a anterior (rotação). O segredo só aparece nesta resposta. */
apiKeys.post('/api-keys', async c => {
  authorize(c.var.principal, 'team')
  const workspace = c.var.principal.workspaceId
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('')
  const key = { id: crypto.randomUUID(), last4: secret.slice(-4) }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE api_keys SET revoked_at=? WHERE workspace_id=? AND revoked_at IS NULL').bind(Date.now(), workspace),
    c.env.DB.prepare('INSERT INTO api_keys (id,workspace_id,hash,last4,created_by) VALUES (?,?,?,?,?)').bind(key.id, workspace, await sha256(secret), key.last4, c.var.principal.userId),
  ])
  return c.json({ ...key, token: `${workspace}:${secret}` }, 201)
})
apiKeys.delete('/api-keys', async c => {
  authorize(c.var.principal, 'team')
  await c.env.DB.prepare('UPDATE api_keys SET revoked_at=? WHERE workspace_id=? AND revoked_at IS NULL').bind(Date.now(), c.var.principal.workspaceId).run()
  return c.body(null, 204)
})

// ───────── Chaves do perfil (valem em todos os espaços da pessoa; várias ativas, cada uma com nome e tipo) ─────────
const PROFILE_KEY_COLUMNS = 'id,name,scope,last4,created_at,last_used_at'
export type ProfileKeyScope = 'read' | 'write'
const profileKeyInput = z.object({ name: z.string().trim().min(1).max(80), scope: z.enum(['read', 'write']).default('write') }).strict()
/** Chaves ativas do perfil, da mais nova para a mais antiga. */
const activeProfileKeys = (env: Env, userId: string) =>
  env.DB.prepare(`SELECT ${PROFILE_KEY_COLUMNS} FROM user_api_keys WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC`).bind(userId)
/** Chave de perfil ativa pelo hash do segredo, com o e-mail do dono e se ele está verificado (middleware de `/api/*`). */
export const findProfileKeyByHash = (env: Env, secretHash: string) => env.DB.prepare(`SELECT k.id,k.user_id,k.scope,k.last_used_at,u.email,u."emailVerified" AS email_verified
  FROM user_api_keys k JOIN "user" u ON u.id=k.user_id WHERE k.hash=? AND k.revoked_at IS NULL`).bind(secretHash)
  .first<{ id: string; user_id: string; scope: ProfileKeyScope | null; last_used_at: number | null; email: string; email_verified: number }>()
/** Só a mais recente (cliente de antes das chaves com nome). A lista completa fica em GET /profile/api-keys. */
apiKeys.get('/profile/api-key', async c => c.json(await activeProfileKeys(c.env, c.var.principal.userId).first() ?? null))
apiKeys.get('/profile/api-keys', async c => c.json({ items: (await activeProfileKeys(c.env, c.var.principal.userId).all()).results }))
/** Cria uma chave nova com nome (obrigatório) e tipo ('read' só lê; 'write', padrão, lê e muda). As outras seguem ativas. O segredo só aparece nesta resposta. */
apiKeys.post('/profile/api-key', async c => {
  // Sem corpo (cliente antigo): nome padrão. Com corpo, o nome não pode vir vazio.
  const raw = await c.req.text()
  const input = profileKeyInput.parse(raw.trim() ? (() => { try { return JSON.parse(raw) } catch { throw new HTTPException(400, { message: 'JSON inválido.' }) } })() : { name: 'Chave de perfil' })
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('')
  const key = { id: crypto.randomUUID(), name: input.name, scope: input.scope, last4: secret.slice(-4), created_at: Date.now() }
  await c.env.DB.prepare('INSERT INTO user_api_keys (id,user_id,hash,last4,created_at,name,scope) VALUES (?,?,?,?,?,?,?)')
    .bind(key.id, c.var.principal.userId, await sha256(secret), key.last4, key.created_at, key.name, key.scope).run()
  return c.json({ ...key, last_used_at: null, token: `perfil:${secret}` }, 201)
})
/** Revoga todas as chaves do perfil; DELETE /profile/api-keys/:id revoga uma só. */
apiKeys.delete('/profile/api-key', async c => {
  await c.env.DB.prepare('UPDATE user_api_keys SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(Date.now(), c.var.principal.userId).run()
  return c.body(null, 204)
})
apiKeys.delete('/profile/api-keys/:id', async c => {
  const done = await c.env.DB.prepare('UPDATE user_api_keys SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL').bind(Date.now(), c.req.param('id'), c.var.principal.userId).run()
  if (!done.meta.changes) throw new HTTPException(404, { message: 'Chave não encontrada.' })
  return c.body(null, 204)
})

/** sendContentByUserRef: envia a quem chegou por um link/plugin e talvez ainda não seja contato; a identidade no canal vira contato novo. */
publicApi.post('/sending/sendContentByUserRef', async c => {
  const input = await body(c, v1SendContentByUserRefSchema)
  if (!hasFlow(c.env)) throw new HTTPException(503, { message: 'O executor de automações não está disponível.' })
  const ws = c.var.workspace
  const channel = await c.env.DB.prepare('SELECT type FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL').bind(ws, input.channel_id).first<string>('type')
  if (!channel) throw new HTTPException(404, { message: 'Conexão não encontrada.' })
  let contact = await c.env.DB.prepare('SELECT contact_id FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?').bind(ws, input.channel_id, input.user_ref).first<string>('contact_id')
  if (!contact) {
    contact = crypto.randomUUID()
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO contacts (id,workspace_id,status) VALUES (?,?,'subscribed')").bind(contact, ws),
      c.env.DB.prepare('INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in,consent_changed_at) VALUES (?,?,?,?,?,?,?)')
        .bind(crypto.randomUUID(), ws, contact, input.channel_id, input.user_ref, ...Object.values(newIdentityConsent(true))),
    ])
  }
  const runId = await sendDynamicContent(c.env, ws, contact, input.channel_id, input.data)
  return ok(c, { run_id: runId, subscriber_id: contact })
})
