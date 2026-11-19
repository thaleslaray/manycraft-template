import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { assertUnlocked } from './automation-actions'
import { createAutomation, publishAutomation, saveDraft } from './db/automations'
import { connectionColumns, connectionFromRow, type ConnectionRow } from './channels/core/connection'

export const basicActions = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const kindSchema = z.enum(['default_reply', 'welcome_message', 'system_opt_in', 'system_opt_out'])
export const basicEntrySchema = z.object({
  automation_id: z.string().min(1).max(128), enabled: z.boolean(),
  repeat_mode: z.enum(['every_time', 'once_per_24_hours']), dm_only: z.boolean(),
}).strict()
type EntryRow = { channel_id: string; kind: z.infer<typeof kindSchema>; automation_id: string; automation_name: string; status: string; repeat_mode: string; config: string }
const entry = (row: EntryRow) => ({ connection_id: row.channel_id, kind: row.kind,
  automation_id: row.automation_id, automation_name: row.automation_name, enabled: row.status === 'active',
  repeat_mode: row.repeat_mode === 'once_per_24_hours' ? 'once_per_24_hours' : 'every_time',
  dm_only: JSON.parse(row.config)?.dm_only === true,
})
const entriesSql = `SELECT t.channel_id,CASE WHEN t.kind='external_trigger' THEN json_extract(t.config,'$.system_kind') ELSE t.kind END AS kind,t.automation_id,a.name AS automation_name,t.status,t.repeat_mode,t.config
  FROM triggers t JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
  JOIN channels c ON c.workspace_id=t.workspace_id AND c.id=t.channel_id
  WHERE t.workspace_id=? AND (t.kind IN ('default_reply','welcome_message') OR (t.kind='external_trigger' AND json_extract(t.config,'$.system_kind') IN ('system_opt_in','system_opt_out'))) AND t.audience='direct'
  AND a.deleted_at IS NULL AND c.archived_at IS NULL`

basicActions.get('/basic', async c => {
  authorize(c.var.principal, 'automation:read')
  z.object({}).strict().parse(c.req.query())
  const ws = c.var.principal.workspaceId
  const [connections, entries] = await Promise.all([
    c.env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND archived_at IS NULL ORDER BY created_at,id`).bind(ws).all<ConnectionRow>(),
    c.env.DB.prepare(entriesSql).bind(ws).all<EntryRow>(),
  ])
  return c.json({ connections: connections.results.map(row => {
    const connection = connectionFromRow(row)
    return { id: connection.id, displayName: connection.displayName ?? 'Conexão sem nome', profile: { inbound: connection.profile.inbound, conversationStarters: connection.profile.conversationStarters, mainMenu: connection.profile.mainMenu } }
  }), entries: entries.results.map(entry) })
})

basicActions.put('/basic/:connection/:kind', async c => {
  authorize(c.var.principal, 'edit')
  const ws = c.var.principal.workspaceId
  const connectionId = z.string().min(1).max(128).parse(c.req.param('connection'))
  const kind = kindSchema.parse(c.req.param('kind'))
  const input = basicEntrySchema.parse(await c.req.json().catch(() => null))
  const row = await c.env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL`)
    .bind(ws, connectionId).first<ConnectionRow>()
  if (!row) throw new HTTPException(404, { message: 'Conexão não encontrada.' })
  const profile = connectionFromRow(row).profile
  if (!profile.inbound.message) throw new HTTPException(400, { message: 'Esta conexão não recebe mensagens.' })
  if (input.dm_only && (!profile.inbound.storyReply || kind !== 'default_reply')) {
    throw new HTTPException(400, { message: 'O filtro de mensagens diretas não está disponível nesta entrada.' })
  }
  const automation = await c.env.DB.prepare(`SELECT status,published_version_id FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL`)
    .bind(ws, input.automation_id).first<{ status: string; published_version_id: string | null }>()
  if (!automation) throw new HTTPException(404, { message: 'Automação não encontrada.' })
  if (input.enabled && (automation.status !== 'live' || !automation.published_version_id)) {
    throw new HTTPException(409, { message: 'Publique e retome a automação antes de ativar esta entrada.' })
  }
  const system = kind === 'system_opt_in' || kind === 'system_opt_out'
  // Ligar a automação à entrada e tirar a que estava ligada são edições das duas: a trava vale para a nova e para a atual.
  await assertUnlocked(c.env.DB, ws, input.automation_id, 'edit', c.var.principal)
  const linked = await c.env.DB.prepare(`${entriesSql} AND t.channel_id=? AND t.kind=? ${system ? "AND json_extract(t.config,'$.system_kind')=?" : ''}`)
    .bind(ws, connectionId, system ? 'external_trigger' : kind, ...(system ? [kind] : [])).first<EntryRow>()
  if (linked) await assertUnlocked(c.env.DB, ws, linked.automation_id, 'edit', c.var.principal)
  const storedKind = system ? 'external_trigger' : kind
  const conflict = system
    ? "(workspace_id,channel_id,json_extract(config,'$.system_kind')) WHERE kind='external_trigger' AND json_extract(config,'$.system_kind') IN ('system_opt_in','system_opt_out') AND channel_id IS NOT NULL AND audience='direct'"
    : "(workspace_id,channel_id,kind) WHERE kind IN ('default_reply','welcome_message') AND channel_id IS NOT NULL AND audience='direct'"
  // O índice parcial arbitra edições concorrentes; trocar a associação preserva o histórico da frequência.
  await c.env.DB.prepare(`INSERT INTO triggers (id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT${conflict}
    DO UPDATE SET automation_id=excluded.automation_id,status=excluded.status,repeat_mode=excluded.repeat_mode,config=excluded.config,updated_at=?`)
    .bind(crypto.randomUUID(), ws, input.automation_id, connectionId,
      ({ default_reply: 'Resposta padrão', welcome_message: 'Mensagem de boas-vindas', system_opt_in: 'Confirmação de inscrição', system_opt_out: 'Confirmação de descadastro' })[kind], storedKind,
      input.enabled ? 'active' : 'draft', kind === 'welcome_message' ? 'once' : kind === 'default_reply' ? input.repeat_mode : 'every_time',
      JSON.stringify({ dm_only: input.dm_only, ...(system ? { system_kind: kind } : {}) }), Date.now()).run()
  const saved = await c.env.DB.prepare(`${entriesSql} AND t.channel_id=? AND t.kind=? ${system ? "AND json_extract(t.config,'$.system_kind')=?" : ''}`).bind(ws, connectionId, storedKind, ...(system ? [kind] : [])).first<EntryRow>()
  return c.json(entry(saved!))
})

/**
 * Fluxo de descadastro padrão (4 passos): confirma a saída citando {{nome_da_pagina}}, oferece o botão Inscrever, reinscreve na conexão
 * e agradece. Cria, publica e liga como confirmação de descadastro da conexão.
 */
basicActions.post('/basic/:connection/system_opt_out/default', async c => {
  authorize(c.var.principal, 'edit')
  const ws = c.var.principal.workspaceId
  const connectionId = z.string().min(1).max(128).parse(c.req.param('connection'))
  if (!await c.env.DB.prepare('SELECT 1 FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL').bind(ws, connectionId).first()) throw new HTTPException(404, { message: 'Conexão não encontrada.' })
  const linked = await c.env.DB.prepare(`${entriesSql} AND t.channel_id=? AND t.kind='external_trigger' AND json_extract(t.config,'$.system_kind')='system_opt_out'`).bind(ws, connectionId).first<EntryRow>()
  if (linked) await assertUnlocked(c.env.DB, ws, linked.automation_id, 'edit', c.var.principal)   // troca a confirmação ligada: edita a automação de hoje
  const automation = await createAutomation(c.env.DB, ws, { name: 'Descadastro (padrão)' })
  await saveDraft(c.env.DB, ws, automation.id, { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 80 }, config: {} },
    { id: 'saida', type: 'message', position: { x: 340, y: 80 }, config: { blocks: [{ kind: 'text', text: 'Pronto: você não vai mais receber mensagens de {{nome_da_pagina|nós}}. Mudou de ideia? Toque em Inscrever.' },
      { kind: 'button', id: 'inscrever', label: 'Inscrever', action: { type: 'go_to_node' } }] } },
    { id: 'reinscrever', type: 'action', position: { x: 700, y: 80 }, config: { actions: [{ type: 'subscribe_to_account', connection_id: connectionId }] } },
    { id: 'volta', type: 'message', position: { x: 1040, y: 80 }, config: { blocks: [{ kind: 'text', text: 'Inscrição retomada. Que bom ter você de volta em {{nome_da_pagina|nossa lista}}!' }] } },
  ], edges: [{ from: 'trigger', port: 'next', to: 'saida' }, { from: 'saida', port: 'btn:inscrever', to: 'reinscrever' }, { from: 'reinscrever', port: 'next', to: 'volta' }] })
  await publishAutomation(c.env.DB, ws, automation.id)
  await c.env.DB.prepare(`INSERT INTO triggers (id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES (?,?,?,?,'Confirmação de descadastro','external_trigger','active','every_time',?)
    ON CONFLICT(workspace_id,channel_id,json_extract(config,'$.system_kind')) WHERE kind='external_trigger' AND json_extract(config,'$.system_kind') IN ('system_opt_in','system_opt_out') AND channel_id IS NOT NULL AND audience='direct'
    DO UPDATE SET automation_id=excluded.automation_id,status='active',updated_at=?`)
    .bind(crypto.randomUUID(), ws, automation.id, connectionId, JSON.stringify({ dm_only: false, system_kind: 'system_opt_out' }), Date.now()).run()
  return c.json({ automation_id: automation.id }, 201)
})
