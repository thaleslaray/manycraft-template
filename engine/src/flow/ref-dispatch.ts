import { REF_URL_WIDGET } from '../../../shared/trigger-types'
import { isAutomationPaused } from '../inbox/service'
import { stableId, object, type FlowEnv } from './types'
import type { InboundEvent } from '../integrations'

/** Um link de referência ativo, na forma que o despacho usa para escolher o gatilho. */
export type RefTrigger = { id: string; automation_id: string; published_version_id: string; repeat_mode: string; config: string; payload?: string }

const active = `SELECT t.id,t.automation_id,t.repeat_mode,t.config,a.published_version_id FROM triggers t
  JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
  WHERE t.workspace_id=? AND t.channel_id=? AND t.kind='widget' AND t.widget_type='${REF_URL_WIDGET}' AND t.status='active'
  AND a.status='live' AND a.deleted_at IS NULL AND a.published_version_id IS NOT NULL`

/** Canais com ref no webhook (?ref= do link público). `ref` é o nome antigo da chave `code`. */
export async function refByCode(env: FlowEnv, ws: string, channelId: string, ref: string): Promise<RefTrigger | undefined> {
  const find = (code: string) => env.DB.prepare(`${active} AND coalesce(json_extract(t.config,'$.code'),json_extract(t.config,'$.ref'))=? ORDER BY t.created_at,t.id LIMIT 1`)
    .bind(ws, channelId, code).first<RefTrigger>()
  const exact = await find(ref)
  if (exact) return exact
  // Dados extras no link: CODIGO--dados. O código escolhe o gatilho; os dados vão para o campo configurado.
  const split = ref.indexOf('--')
  if (split <= 0) return undefined
  const trigger = await find(ref.slice(0, split))
  if (!trigger) return undefined
  let payload = ref.slice(split + 2)
  try { payload = decodeURIComponent(payload) } catch { /* fica como veio */ }
  return { ...trigger, payload: payload.slice(0, 500) }
}

/** Grava os dados extras do link no campo escolhido do contato (campo de texto ainda ativo). */
export function refPayloadStatement(env: FlowEnv, ws: string, contactId: string, trigger: RefTrigger | undefined): D1PreparedStatement | null {
  const field = trigger?.payload ? object(JSON.parse(trigger.config)).payload_field_id : undefined
  if (typeof field !== 'string' || !trigger?.payload) return null
  return env.DB.prepare(`INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value) SELECT ?,?,id,? FROM custom_fields
    WHERE workspace_id=? AND id=? AND scope='contact' AND type='text' AND archived=0 ON CONFLICT(contact_id,field_id) DO UPDATE SET value=excluded.value,updated_at=?`)
    .bind(ws, contactId, JSON.stringify(trigger.payload), ws, field, Date.now())
}

const squash = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * O texto de uma mensagem do contato é a abertura de um link de referência quando termina no código do link (palavra inteira, ao fim da mensagem)
 * e o que vem antes é o texto pré-preenchido do link (sem texto configurado, a mensagem é só o código). Código solto no meio de uma frase não conta.
 */
export function textOpensRef(text: string, config: { code?: unknown; text?: unknown }): boolean {
  const code = typeof config.code === 'string' ? squash(config.code) : ''
  if (!code) return false
  const message = squash(text)
  if (message !== code && !message.endsWith(` ${code}`)) return false
  const before = message.slice(0, message.length - code.length).trim()
  return before === squash(typeof config.text === 'string' ? config.text : '')
}

/** Canal cujo link só traz texto pré-preenchido: o código do link viaja no fim da mensagem. */
export async function refByText(env: FlowEnv, ws: string, channelId: string, text: string): Promise<RefTrigger | undefined> {
  const rows = await env.DB.prepare(`${active} AND length(coalesce(json_extract(t.config,'$.code'),''))>0 ORDER BY t.created_at,t.id`)
    .bind(ws, channelId).all<RefTrigger>()
  return rows.results.find(row => textOpensRef(text, object(JSON.parse(row.config))))
}

/** Abre a execução do link para quem já é contato nesta conexão (clique em Começar ou conversa que já existia). Devolve se abriu. */
export async function planRefRun(env: FlowEnv, event: InboundEvent, inboundId: string, trigger: RefTrigger, externalUserId: string): Promise<boolean> {
  const contact = await env.DB.prepare(`SELECT c.id,c.status FROM contacts c JOIN contact_channels cc ON cc.workspace_id=c.workspace_id AND cc.contact_id=c.id
    WHERE c.workspace_id=? AND cc.channel_id=? AND cc.external_user_id=?`).bind(event.workspaceId, event.channelId, externalUserId).first<{ id: string; status: string }>()
  if (!contact || contact.status !== 'subscribed' || await isAutomationPaused(env, event.workspaceId, contact.id)) return false
  const now = Date.now(), dedupe = trigger.repeat_mode === 'once' ? 'once' : inboundId
  const start = object(JSON.parse(trigger.config)).node_id
  const runId = `flow-${await stableId(inboundId, trigger.id)}`
  const payload = refPayloadStatement(env, event.workspaceId, contact.id, trigger)
  await env.DB.batch([
    ...(payload ? [payload] : []),
    env.DB.prepare(`INSERT INTO trigger_firings (workspace_id,trigger_id,contact_id,external_event_id,dedupe_key,fired_at)
      SELECT ?,?,?,?,?,? FROM triggers t JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
      WHERE t.workspace_id=? AND t.id=? AND t.status='active' AND a.status='live' AND a.deleted_at IS NULL
      AND (?<>'once_per_24_hours' OR NOT EXISTS (SELECT 1 FROM trigger_firings WHERE workspace_id=? AND trigger_id=? AND contact_id=? AND fired_at>?))
      ON CONFLICT(trigger_id,contact_id,dedupe_key) DO NOTHING`)
      .bind(event.workspaceId, trigger.id, contact.id, inboundId, dedupe, now, event.workspaceId, trigger.id, trigger.repeat_mode, event.workspaceId, trigger.id, contact.id, now - 86400000),
    env.DB.prepare(`INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,trigger_id,inbound_event_id,channel_id,start_node_id)
      SELECT ?,?,?,?,?,?,?,? FROM trigger_firings WHERE workspace_id=? AND trigger_id=? AND contact_id=? AND dedupe_key=? AND external_event_id=? ON CONFLICT(id) DO NOTHING`)
      .bind(runId, event.workspaceId, contact.id, trigger.published_version_id, trigger.id, inboundId, event.channelId, typeof start === 'string' ? start : null,
        event.workspaceId, trigger.id, contact.id, dedupe, inboundId),
  ])
  return true
}
