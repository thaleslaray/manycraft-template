import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { json } from './security'
import { decryptCredentials, encryptCredentials, type KeyringEnv } from './channels/core/crypto'
import { extractPath, isInternalHost } from './flow/external-url'
import { contactVariableRenderer } from './db/message-variables'

/**
 * Apps (Dev Program de estudo): um JSON descreve auth (APIKEY), actions (formulário + requests em sequência + mapping JSONPath)
 * e sources (enum:static e enum:rpc). Parâmetros de auth viram [[nome]]; a connection injeta cabeçalhos ou query em toda request;
 * campos de sistema (page_id, user_id, first_name...) entram como [[system.nome]] e os do formulário como [[input.nome]].
 */
const request = z.object({ method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'), url: z.string().min(1).max(2000),
  headers: z.record(z.string().max(100), z.string().max(2000)).default({}), body: z.unknown().optional() })
const formField = z.object({ name: z.string().regex(/^[a-z_][a-z0-9_]{0,40}$/), label: z.string().max(80), type: z.enum(['string', 'number', 'select']), source: z.string().max(40).optional(), required: z.boolean().default(false) })
export const appSpec = z.object({
  name: z.string().min(1).max(80), version: z.string().max(20).default('1.0'),
  auth: z.object({ type: z.literal('APIKEY'), params: z.array(z.object({ name: z.string().regex(/^[a-z_][a-z0-9_]{0,40}$/), label: z.string().max(80) })).max(10),
    connection: z.object({ headers: z.record(z.string().max(100), z.string().max(2000)).default({}), query: z.record(z.string().max(100), z.string().max(2000)).default({}) }).default({ headers: {}, query: {} }),
    request: request.optional() }).optional(),
  actions: z.array(z.object({ name: z.string().regex(/^[a-z_][a-z0-9_]{0,40}$/), label: z.string().max(80), form: z.array(formField).max(20).default([]),
    requests: z.array(request).min(1).max(5), mapping: z.array(z.object({ path: z.string().max(200), field: z.string().max(100) })).max(20).default([]) })).max(30).default([]),
  triggers: z.array(z.object({ name: z.string().max(40), label: z.string().max(80) })).max(20).default([]),
  sources: z.record(z.string().max(40), z.union([z.object({ type: z.literal('enum:static'), values: z.array(z.object({ key: z.string().max(200), value: z.string().max(200) })).max(200) }),
    z.object({ type: z.literal('enum:rpc'), request, mapping: z.object({ list: z.string().max(200).default('$'), key: z.string().max(100), value: z.string().max(100) }) })])).default({}),
})
export type AppSpec = z.infer<typeof appSpec>
const scope = (ws: string, id: string) => ({ workspaceId: ws, connectionId: `app:${id}` })

export async function loadApp(env: KeyringEnv & { DB: D1Database }, ws: string, id: string) {
  const row = await env.DB.prepare('SELECT spec,ciphertext,iv,key_version FROM installed_apps WHERE workspace_id=? AND id=?').bind(ws, id).first<{ spec: string; ciphertext: string | null; iv: string | null; key_version: number | null }>()
  if (!row) return null
  const params = row.ciphertext ? await decryptCredentials(env, scope(ws, id), { ciphertext: row.ciphertext, iv: row.iv!, keyVersion: row.key_version! }) as Record<string, string> : {}
  return { spec: appSpec.parse(JSON.parse(row.spec)), params }
}
const fill = (value: unknown, vars: Record<string, string>): unknown =>
  typeof value === 'string' ? value.replace(/\[\[\s*([a-z_.0-9]+)\s*\]\]/gi, (_, k: string) => vars[k] ?? '')
    : Array.isArray(value) ? value.map(v => fill(v, vars))
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)])) : value

/** Uma request do app: variáveis preenchidas, connection injetada, só https público, 10 s. */
export async function appRequest(app: { spec: AppSpec; params: Record<string, string> }, req: z.infer<typeof request>, vars: Record<string, string>, fetcher: typeof fetch = fetch): Promise<unknown> {
  const all = { ...Object.fromEntries(Object.entries(app.params)), ...vars }
  const url = new URL(String(fill(req.url, all)))
  if (url.protocol !== 'https:' || isInternalHost(url.hostname)) throw new Error('O app só chama endereços https públicos.')
  for (const [k, v] of Object.entries(app.spec.auth?.connection.query ?? {})) url.searchParams.set(k, String(fill(v, all)))
  const headers = { 'content-type': 'application/json', ...fill(req.headers, all) as Record<string, string>, ...fill(app.spec.auth?.connection.headers ?? {}, all) as Record<string, string> }
  const r = await fetcher(url, { method: req.method, headers, ...(req.body === undefined || req.method === 'GET' ? {} : { body: JSON.stringify(fill(req.body, all)) }), redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`O serviço do app respondeu ${r.status}.`)
  const text = (await r.text()).slice(0, 1_000_000)
  try { return JSON.parse(text) } catch { return text }
}

/** Campos de sistema que o app pode pedir (System fields). */
export async function systemFields(db: D1Database, ws: string, contactId: string, channelId: string | null) {
  const c = await db.prepare(`SELECT c.id,c.first_name,c.last_name,c.gender,c.locale,c.timezone,c.phone,c.email,c.status,
      (SELECT cc.external_user_id FROM contact_channels cc WHERE cc.workspace_id=c.workspace_id AND cc.contact_id=c.id AND (? IS NULL OR cc.channel_id=?) LIMIT 1) AS external_id,
      (SELECT cc.opted_in FROM contact_channels cc WHERE cc.workspace_id=c.workspace_id AND cc.contact_id=c.id AND (? IS NULL OR cc.channel_id=?) LIMIT 1) AS opted_in
    FROM contacts c WHERE c.workspace_id=? AND c.id=?`).bind(channelId, channelId, channelId, channelId, ws, contactId).first<Record<string, string | number | null>>()
  const s = (v: unknown) => v == null ? '' : String(v)
  return { 'system.page_id': s(channelId), 'system.user_id': s(c?.id), 'system.external_id': s(c?.external_id), 'system.first_name': s(c?.first_name), 'system.last_name': s(c?.last_name),
    'system.name': [c?.first_name, c?.last_name].filter(Boolean).join(' '), 'system.gender': s(c?.gender), 'system.locale': s(c?.locale), 'system.language': s(c?.locale).split(/[-_]/)[0] ?? '',
    'system.timezone': s(c?.timezone), 'system.phone': s(c?.phone), 'system.email': s(c?.email), 'system.opted_in': c?.opted_in ? 'true' : 'false', 'system.app_id': '', 'system.app_version': '' }
}

/** Executa uma action do app para o contato: requests em sequência (resposta anterior em [[last.caminho]]) e mapping para campos. */
export async function runAppAction(env: KeyringEnv & { DB: D1Database }, ws: string, run: { contact_id: string; channel_id: string | null }, appId: string, actionName: string, inputs: Record<string, string>, fetcher: typeof fetch = fetch) {
  const app = await loadApp(env, ws, appId)
  if (!app) throw new Error('App não instalado.')
  const action = app.spec.actions.find(a => a.name === actionName)
  if (!action) throw new Error('Ação do app não encontrada.')
  const render = await contactVariableRenderer(env.DB, ws, run.contact_id)
  const vars: Record<string, string> = { ...await systemFields(env.DB, ws, run.contact_id, run.channel_id), 'system.app_id': appId, 'system.app_version': app.spec.version,
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`input.${k}`, render(v)])) }
  let last: unknown = null
  for (const req of action.requests) {
    const withLast = { ...vars, ...Object.fromEntries(flatten(last).map(([k, v]) => [`last.${k}`, v])) }
    last = await appRequest(app, req, withLast, fetcher)
  }
  const mapped: Record<string, unknown> = {}
  for (const m of action.mapping) {
    const value = extractPath(last, m.path)
    if (value === undefined) continue
    const field = await env.DB.prepare("SELECT id,type FROM custom_fields WHERE workspace_id=? AND name=? AND scope='contact' AND archived=0").bind(ws, m.field).first<{ id: string; type: string }>()
    if (!field) continue
    const stored = field.type === 'number' ? Number(value) : typeof value === 'string' ? value : JSON.stringify(value)
    await env.DB.prepare('INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value) VALUES (?,?,?,?) ON CONFLICT(contact_id,field_id) DO UPDATE SET value=excluded.value,updated_at=?')
      .bind(ws, run.contact_id, field.id, JSON.stringify(stored), Date.now()).run()
    mapped[m.field] = stored
  }
  return { response: last, mapped }
}
function flatten(value: unknown, prefix = ''): [string, string][] {
  if (value === null || typeof value !== 'object') return prefix ? [[prefix, value == null ? '' : String(value)]] : []
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k)).slice(0, 500)
}

export const appInstallSchema = z.object({ spec: appSpec, params: z.record(z.string().max(40), z.string().max(2000)).default({}) }).strict()
export const apps = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const id = z.string().min(1).max(128)
apps.get('/apps', async c => {
  authorize(c.var.principal, 'automation:read')
  const rows = await c.env.DB.prepare('SELECT id,name,spec,created_at FROM installed_apps WHERE workspace_id=? ORDER BY created_at').bind(c.var.principal.workspaceId).all<{ id: string; name: string; spec: string; created_at: number }>()
  return c.json({ items: rows.results.map(r => { const spec = appSpec.parse(JSON.parse(r.spec)); return { id: r.id, name: r.name, version: spec.version, created_at: r.created_at,
    actions: spec.actions.map(a => ({ name: a.name, label: a.label, form: a.form })), triggers: spec.triggers, auth_params: spec.auth?.params ?? [] } }) })
})
/** Instala: valida o JSON e, com auth APIKEY, os parâmetros; se o app tem request de auth, ela é testada antes de salvar. */
apps.post('/apps', async c => {
  authorize(c.var.principal, 'team')
  const input = appInstallSchema.parse(await json(c.req.raw))
  for (const p of input.spec.auth?.params ?? []) if (!input.params[p.name]) throw new HTTPException(400, { message: `Informe ${p.label}.` })
  if (input.spec.auth?.request) {
    try { await appRequest({ spec: input.spec, params: input.params }, input.spec.auth.request, {}) }
    catch (e) { throw new HTTPException(400, { message: `A autenticação do app falhou: ${e instanceof Error ? e.message : 'erro'}` }) }
  }
  const key = crypto.randomUUID(), ws = c.var.principal.workspaceId
  const sealed = Object.keys(input.params).length ? await encryptCredentials(c.env, scope(ws, key), input.params) : null
  await c.env.DB.prepare('INSERT INTO installed_apps (id,workspace_id,name,spec,ciphertext,iv,key_version,installed_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(key, ws, input.spec.name, JSON.stringify(input.spec), sealed?.ciphertext ?? null, sealed?.iv ?? null, sealed?.keyVersion ?? null, c.var.principal.userId, Date.now()).run()
  return c.json({ id: key, name: input.spec.name }, 201)
})
apps.delete('/apps/:id', async c => {
  authorize(c.var.principal, 'team')
  const r = await c.env.DB.prepare('DELETE FROM installed_apps WHERE workspace_id=? AND id=?').bind(c.var.principal.workspaceId, id.parse(c.req.param('id'))).run()
  if (!r.meta.changes) throw new HTTPException(404, { message: 'App não encontrado.' })
  return c.body(null, 204)
})
/** Lista de opções de um campo select: enum:static devolve os valores; enum:rpc chama o serviço e mapeia key/value. */
apps.get('/apps/:id/sources/:name', async c => {
  authorize(c.var.principal, 'automation:read')
  const app = await loadApp(c.env, c.var.principal.workspaceId, id.parse(c.req.param('id')))
  const source = app?.spec.sources[c.req.param('name')]
  if (!app || !source) throw new HTTPException(404, { message: 'Lista não encontrada.' })
  if (source.type === 'enum:static') return c.json({ items: source.values })
  try {
    const body = await appRequest(app, source.request, {})
    const raw = (source.mapping.list === '$' ? body : extractPath(body, source.mapping.list)) ?? []
    const list = Array.isArray(raw) ? raw : []
    return c.json({ items: list.slice(0, 500).map(item => ({ key: String(extractPath(item, source.mapping.key) ?? ''), value: String(extractPath(item, source.mapping.value) ?? '') })) })
  } catch (e) { throw new HTTPException(502, { message: e instanceof Error ? e.message : 'Falha ao buscar a lista.' }) }
})
