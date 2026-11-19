import { z } from 'zod'
import { connectionColumns, connectionFromRow, type ConnectionRow } from '../channels/core/connection'
import { RepositoryError, requireRow, type Row } from './shared'
import { getAutomation } from './automations'
import { REF_URL_WIDGET } from '../../../shared/trigger-types'
import { refLink, prefillText, PREFILL_MAX, type RefChannel } from '../../../shared/ref-link'
import { normalizeHandle, prefillMax, refChannelOf } from '../channels/ref-link'

export { refLink, prefillText, PREFILL_MAX }

const id = z.string().min(1).max(128)
const repeat = z.enum(['once', 'every_time', 'once_per_24_hours'])
const state = z.enum(['active', 'draft', 'initial'])

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
/** Código curto e aleatório do link: só letras e números, sem os que se confundem (i, l, o, 0, 1). */
export function newRefCode(): string {
  const out: string[] = []
  while (out.length < 8) for (const byte of crypto.getRandomValues(new Uint8Array(16))) if (byte < 248 && out.length < 8) out.push(ALPHABET[byte % ALPHABET.length])
  return out.join('')
}

// payload_field_id: o que vier depois de `--` no ref do link (ex.: ?ref=CODIGO--azul) vai para este campo de texto do contato.
export const refConfig = z.object({ handle: z.string().trim().min(1).max(100), text: z.string().trim().max(PREFILL_MAX).optional(), payload_field_id: id.nullable().optional() }).strict()
export const createRefSchema = z.object({ type: z.literal('ref_url'), name: z.string().trim().min(1).max(100), connection_id: id, node_id: id,
  config: refConfig, enabled: z.boolean().default(false), repeat_mode: repeat.optional() }).strict()
export const patchRefSchema = z.object({ connection_id: id.optional(), config: refConfig.optional(), name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(), state: state.optional(), repeat_mode: repeat.optional() }).strict()

function handleOf(channel: RefChannel, raw: string): string {
  const result = normalizeHandle(channel, raw)
  if (!result.ok) throw new RepositoryError(result.message, 400)
  return result.handle
}

/** `ref` é o formato antigo do gatilho (só o código, sem endereço): ainda aparece em bancos anteriores ao link com endereço. */
type Stored = { node_id?: string; code?: string; ref?: string; handle?: string; text?: string; payload_field_id?: string }

export function presentRef(row: Row, ws: string, automation: string) {
  const config = JSON.parse(String(row.config)) as Stored
  const channel = row.channel_type as RefChannel
  const code = config.code ?? config.ref ?? ''
  return { id: String(row.id), workspace_id: ws, automation_id: automation, channel_id: row.channel_id as string, channel_type: channel,
    name: String(row.name), type: 'ref_url' as const, node_id: config.node_id as string,
    config: { handle: config.handle ?? '', ...(config.text ? { text: config.text } : {}), ...(config.payload_field_id ? { payload_field_id: config.payload_field_id } : {}), code, link: config.handle && code ? refLink(channel, config.handle, code, config.text) : null,
      target: 'all' as const, include: [] as string[], exclude: [] as string[], public_replies: [] as string[] },
    enabled: row.status === 'active', active: row.status === 'active',
    state: row.status === 'active' ? 'active' as const : row.status === 'initial' ? 'initial' as const : 'draft' as const,
    repeat_mode: row.repeat_mode as 'once' | 'every_time' | 'once_per_24_hours', keywords: [],
    created_at: new Date(Number(row.created_at)).toISOString(), updated_at: new Date(Number(row.updated_at)).toISOString() }
}

export const refWhere = `(t.kind='widget' AND t.widget_type='${REF_URL_WIDGET}')`

export async function refTriggerRows(db: D1Database, ws: string, automation: string) {
  const rows = await db.prepare(`SELECT t.*,ch.type AS channel_type FROM triggers t JOIN channels ch ON ch.workspace_id=t.workspace_id AND ch.id=t.channel_id
    WHERE t.workspace_id=? AND t.automation_id=? AND ${refWhere} AND t.status<>'disabled' ORDER BY t.created_at,t.id`).bind(ws, automation).all<Row>()
  return rows.results.map(row => presentRef(row, ws, automation))
}

async function connectionOf(db: D1Database, ws: string, connectionId: string): Promise<RefChannel> {
  const row = requireRow(await db.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL`).bind(ws, connectionId).first<ConnectionRow>())
  const connection = connectionFromRow(row)
  const channel = refChannelOf(connection.kind)
  if (!channel) throw new RepositoryError('Esta conexão não tem link de referência.', 400)
  if (connection.status !== 'connected') throw new RepositoryError('Esta conexão está desconectada.', 400)
  return channel
}

/** Cria (sem triggerId) ou edita um link de referência. O código nasce com o link e não muda: o link já impresso continua valendo. */
export async function saveRefTrigger(db: D1Database, ws: string, automation: string, input: unknown, triggerId?: string) {
  const detail = requireRow(await getAutomation(db, ws, automation))
  const old = triggerId ? requireRow(await db.prepare(`SELECT t.* FROM triggers t WHERE t.workspace_id=? AND t.automation_id=? AND t.id=? AND ${refWhere} AND t.status<>'disabled'`).bind(ws, automation, triggerId).first<Row>()) : null
  const create = old ? null : createRefSchema.parse(input)
  const patch = old ? patchRefSchema.parse(input) : null
  const previous = old ? JSON.parse(String(old.config)) as Stored : null
  const connectionId = create?.connection_id ?? patch?.connection_id ?? String(old!.channel_id)
  const channel = await connectionOf(db, ws, connectionId)
  const raw = create?.config ?? patch?.config ?? { handle: previous!.handle ?? '', text: previous!.text, payload_field_id: previous!.payload_field_id }
  const payloadField = raw.payload_field_id === undefined ? previous?.payload_field_id : raw.payload_field_id ?? undefined
  if (payloadField && !await db.prepare("SELECT id FROM custom_fields WHERE workspace_id=? AND id=? AND scope='contact' AND type='text' AND archived=0").bind(ws, payloadField).first())
    throw new RepositoryError('Escolha um campo de texto do contato para os dados do link.', 400)
  if (!raw.handle) throw new RepositoryError('Informe o endereço do link (número, Página ou usuário) para salvar.', 400)
  const handle = handleOf(channel, raw.handle)
  const text = prefillMax(channel) ? raw.text || undefined : undefined
  const nodeId = create ? create.node_id : String(previous!.node_id)
  if (!detail.automation.draft_graph.nodes.some(n => n.id === nodeId && n.type === 'trigger')) throw new RepositoryError('Escolha um passo de gatilho desta automação.', 400)
  const code = previous?.code ?? previous?.ref ?? newRefCode()
  if (text && prefillText(text, code).length > prefillMax(channel)) throw new RepositoryError(`A mensagem pré-preenchida (com o código) vai até ${prefillMax(channel)} caracteres.`, 400)
  const status = create ? (create.enabled ? 'active' : 'initial') : patch!.state ?? (patch!.enabled === undefined ? String(old!.status) : patch!.enabled ? 'active' : 'draft')
  if (status === 'active' && !detail.published_version) throw new RepositoryError('Publique a automação antes de ativar este gatilho.', 409)
  if (status === 'active' && detail.published_version && !detail.published_version.graph.nodes.some(node => node.id === nodeId)) throw new RepositoryError('Publique o rascunho antes de ativar este gatilho.', 409)
  const mode = create ? create.repeat_mode ?? 'once_per_24_hours' : patch!.repeat_mode ?? String(old!.repeat_mode)
  const stored: Stored = { node_id: nodeId, code, handle, ...(text ? { text } : {}), ...(payloadField ? { payload_field_id: payloadField } : {}) }
  const key = triggerId ?? crypto.randomUUID(), now = Date.now()
  if (old) await db.prepare('UPDATE triggers SET channel_id=?,name=coalesce(?,name),config=?,status=?,repeat_mode=?,updated_at=? WHERE workspace_id=? AND id=?')
    .bind(connectionId, patch!.name ?? null, JSON.stringify(stored), status, mode, now, ws, key).run()
  else await db.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,config) VALUES (?,?,?,?,?,'widget','${REF_URL_WIDGET}',?,?,?)`)
    .bind(key, ws, automation, connectionId, create!.name, status, mode, JSON.stringify(stored)).run()
  return requireRow((await refTriggerRows(db, ws, automation)).find(t => t.id === key) ?? null)
}

/** Excluir é arquivar: o gatilho sai das listas e deixa de disparar (status 'disabled'), mas o código do link, as impressões e os disparos continuam, para o histórico e as métricas. */
export async function deleteRefTrigger(db: D1Database, ws: string, automation: string, triggerId: string) {
  const row = requireRow(await db.prepare(`SELECT t.id FROM triggers t WHERE t.workspace_id=? AND t.automation_id=? AND t.id=? AND ${refWhere} AND t.status<>'disabled'`).bind(ws, automation, triggerId).first<Row>())
  await db.prepare("UPDATE triggers SET status='disabled',updated_at=? WHERE workspace_id=? AND id=?").bind(Date.now(), ws, String(row.id)).run()
  return { ok: true as const }
}
