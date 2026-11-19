import { z } from 'zod'
import { isCards, cardTexts, cardsMessage, mergeLeadText, type LeadCardsBlock } from '../schemas/message-cards'
import { contactVariableRenderer, validateMessageVariables } from './message-variables'
import { HTTPException } from 'hono/http-exception'
import type { Env } from '../env'
import { authorize, type Principal } from '../permissions'
import { adapterEnvFor, broadcastKinds, canBroadcast, connectionAdapter, channelConfigured, resolveProvider, type ChannelAdapter, type ChannelType, type CanSend, type OutboundMessage, type SendResult } from '../channels'
import type { ChannelProfile, StoredProvider } from '../channels/contract'
import { connectionRuntime } from '../channels/core/runtime'
import { connectionColumns, connectionFromRow, type ConnectionRow } from '../channels/core/connection'
import { channelKinds, type TemplateCategory } from '../channels/types'
import { stableId, type Run, type FlowEnv } from '../flow/types'
import { ensureWorkflow } from '../flow/dispatch'
import { moveRun, runGuard } from '../flow/run-state'
import { messageSchema, milliseconds } from '../flow/nodes'
import { validateGraph, messageNodeTypes } from '../schemas/graph'
import { ensureConversation, recordMessage } from '../inbox/service'
import { inboxText } from '../channels/core/delivery'
import { prepareTemplateMessage, templateDisplayText } from '../inbox/template-message'
import { emailFilterSql, savedSegmentSql } from '../email-channel/filters'
import { storedMedia } from '../media-blocks'
import { mediaError, mediaLabels } from '../schemas/message-media'
import { messageVariables } from '../schemas/message-variables'
import { broadcastLink } from '../broadcast-links'
import { failureAction, noteConnectionFailure, recipientFailure } from '../channels/core/failure'
import { enabledSql, SENDING_STATES, stateInSql } from '../channels/core/connection-state'

const id = z.string().min(1).max(128)
const emailAction = z.object({ type:z.enum(['add_tag','remove_tag']), tag_id:id }).strict()
const interaction = z.object({ automationId:id.optional(), actions:z.array(emailAction).max(20).optional() })
const emailContent = z.object({senderId:id.optional(),subject:z.string().trim().min(1).max(998).refine(value=>!/[\r\n]/.test(value)),preheader:z.string().max(1000).optional(),html:z.string().max(5*1024*1024).optional(),onOpen:interaction.extend({mode:z.enum(['once','every'])}).optional(),linkActions:z.array(interaction.extend({url:z.url()})).max(100).optional()}).strict()
export const broadcastInput = z.object({
  id: id.optional(), name: z.string().trim().min(1).max(160), content: z.string().max(100000).default(''),
  audience: z.object({ tag: id.default('all').describe("Etiqueta do público; `all` (padrão) é todo contato do canal. Só é exigida quando `conditions` inclui `tag`; o filtro por segmento usa `segment_id` e o de e-mail, `email_filter`."), channel: z.enum(channelKinds), channel_id: id, segment_id:id.optional(), email_filter:z.enum(['defined','undefined','opened','clicked','opened_clicked','opened_not_clicked','not_opened','subscribed','unsubscribed']).optional(),
    /** Condições abertas no editor, para reabrir como estavam mesmo quando ainda estão no valor padrão. */ conditions:z.array(z.enum(['tag','segment','email'])).max(3).optional() }).strict(),
  email:emailContent.optional(),
  timezone: z.string().max(100).default('America/Sao_Paulo'), scheduled_local: z.string().max(30).default(''),
  scheduled_at: z.iso.datetime().nullable().optional(), status: z.enum(['draft','scheduled','sending']),
  template: z.object({ id, params: z.record(z.string().max(100), z.string().max(32768)).default({}) }).strict().optional(),
  window_kind: z.enum(['automatic','in_window','promotional']).default('automatic'),
  /** Conteúdo montado no mapa de fluxo do editor (mesmo formato do editor de automação); sem e-mail nem modelo. */
  flow: z.object({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()) }).passthrough().optional(),
}).strict()
export const broadcastFromAutomationSchema = z.object({automation_id:id,channel_id:id}).strict()
export const broadcastTestSchema = z.object({contact_id:id}).strict()
export type BroadcastInput = z.infer<typeof broadcastInput>
type WindowKind = BroadcastInput['window_kind']
type Stored = { window_kind: WindowKind; id: string; workspace_id: string; name: string; channel_id: string; channel_type: string;
  content: string; template: string | null; email_content:string|null; copied_graph:string|null; flow:string|null; source_automation_id:string|null; first_node_id:string|null; audience_filter: string; status: string; automation_id: string | null;
  timezone: string; scheduled_local: string; scheduled_at: number | null; updated_at: number; started_at: number | null;
  paused_at: number | null; pause_reason: string | null; retry_at: number | null; lease_until: number | null }
type Recipient = { broadcast_opt_in?: number; resolved_content: string | null; contact_channel_id: string; run_id: string; status: string; contact_id: string; external_user_id: string;
  opted_in: number; contact_status: string; window_expires_at: number | null; human_window_expires_at: number | null;
  identity_kind: string; window_messages_sent: number; marketing_blocked_at: number | null; blocked_at: number | null }
const selection = `SELECT b.*,ch.type AS channel_type FROM broadcasts b JOIN channels ch ON ch.id=b.channel_id AND ch.workspace_id=b.workspace_id`
const missing = () => new HTTPException(404, { message: 'Transmissão não encontrada.' })
const conflict = (message: string) => new HTTPException(409, { message })
const iso = (n: number | null) => n === null ? null : new Date(n).toISOString()
const sendableTypes: string[] = broadcastKinds()
async function stored(env: Pick<Env,'DB'>, workspace: string, broadcastId: string) {
  const row = await env.DB.prepare(`${selection} WHERE b.workspace_id=? AND b.id=?`).bind(workspace, broadcastId).first<Stored>()
  if (!row) throw missing()
  return fromFlow(row)
}
/** O fluxo (um passo, ou o grafo copiado) é a fonte do conteúdo; content/template/email_content são o espelho que o editor e o envio leem daqui. */
/** Id do passo único das transmissões de texto, e-mail e modelo; é o que `broadcastFlow`, `fromFlow` e `planFlow` reconhecem. */
export const broadcastStepId = 'broadcast-message'
export const broadcastFlow = (content: string, email: string | null, template: string | null) => JSON.stringify({
  nodes: [{ id: broadcastStepId, type: 'message', position: { x: 0, y: 0 },
    config: { blocks: [{ kind: 'text', text: content }], ...(email ? { email: JSON.parse(email) } : {}), ...(template ? { template: JSON.parse(template) } : {}) } }],
  edges: [] })
function fromFlow<T extends Pick<Stored, 'flow' | 'copied_graph' | 'content' | 'template' | 'email_content'>>(row: T): T {
  // flow nulo (linha inserida fora da migração 0115): deriva o fluxo de um passo do espelho, pela mesma regra.
  if (!row.flow && !row.copied_graph) return { ...row, flow: broadcastFlow(row.content, row.email_content, row.template) }
  if (!row.flow || row.copied_graph) return row
  const step = (JSON.parse(row.flow) as { nodes: { id: string; config: { blocks?: { kind: string; text?: string }[]; email?: unknown; template?: unknown } }[] }).nodes.find(n => n.id === broadcastStepId)
  if (!step) return row
  return { ...row, content: step.config.blocks?.find(b => b.kind === 'text')?.text ?? '',
    email_content: step.config.email ? JSON.stringify(step.config.email) : null, template: step.config.template ? JSON.stringify(step.config.template) : null }
}
async function channel(env: Env, workspace: string, channelId: string) {
  const row = await env.DB.prepare(`SELECT type,${enabledSql()} AS enabled,external_id,provider FROM channels WHERE workspace_id=? AND id=?`)
    .bind(workspace, channelId).first<{ type: string; enabled: number; external_id: string; provider: StoredProvider }>()
  if (!row) throw new HTTPException(404, { message: 'Canal não encontrado.' })
  return row
}
/** What the connection can do: channel rules, the provider's adjustment and the connection's own override. The one source for templates and windows. */
async function profileOf(env: Env, workspace: string, channelId: string): Promise<ChannelProfile> {
  // The profile needs the row only: decrypting credentials here would turn a bad key into a 500 on a template check.
  return (await connectionRuntime(env, workspace, channelId, { secrets: false })).connection.profile
}
/** The chosen connection decides, by its own provider: one that cannot send a broadcast is refused whatever its channel allows. */
function assertCanBroadcast(ch: { type: string; provider: StoredProvider }) {
  if (!canBroadcast(ch.type as ChannelType, ch.provider)) throw conflict(`Conexões ${resolveProvider(ch.type as ChannelType, ch.provider).label} não enviam transmissões. Escolha outra conexão.`)
}
async function assertChannel(env: Env, workspace: string, channelId: string) {
  const ch = await channel(env, workspace, channelId)
  // Basta estar ligada: a saúde (erro, restrita) é conferida por destinatário na entrega, que pausa com o motivo próprio e retoma depois do conserto.
  if (!ch.enabled || !sendableTypes.includes(ch.type)) throw conflict('Este canal ainda não está disponível para envio.')
  assertCanBroadcast(ch)
  if (!await channelConfigured(env, ch.type as ChannelType, { id: channelId, workspaceId: workspace, provider: ch.provider })) {
    throw conflict(`Configure o canal ${resolveProvider(ch.type as ChannelType, ch.provider).label} antes de enviar.`)
  }
  return ch
}
async function messageFor(env: Env, b: Pick<Stored,'workspace_id'|'channel_id'|'template'|'content'|'email_content'> & {id?:string}): Promise<OutboundMessage> {
  if (b.email_content) {
    if (!(await profileOf(env,b.workspace_id,b.channel_id)).email) throw conflict('A ficha efetiva desta conexão não permite e-mail.')
    const email=emailContent.parse(JSON.parse(b.email_content))
    const sender=await env.DB.prepare("SELECT id FROM email_senders WHERE workspace_id=? AND id=coalesce(?,(SELECT default_sender_id FROM email_settings WHERE workspace_id=?)) AND status='verified'").bind(b.workspace_id,email.senderId ?? null,b.workspace_id).first()
    if (!sender) throw conflict('Escolha um remetente verificado neste espaço.')
    return {kind:'text',text:b.content,email:{...email,...(b.id?{source:{broadcastId:b.id,automationId:`broadcast-${b.id}`,nodeId:broadcastStepId}}:{})}}
  }
  if (!b.template) return { kind: 'text', text: b.content }
  const choice = JSON.parse(b.template) as { id: string; params: Record<string,string> }
  const template = await env.DB.prepare('SELECT status,unavailable_reason FROM message_templates WHERE workspace_id=? AND channel_id=? AND id=?').bind(b.workspace_id,b.channel_id,choice.id)
    .first<{ status: string; unavailable_reason: string | null }>()
  if (!(await profileOf(env, b.workspace_id, b.channel_id)).templates || !template || template.status !== 'approved') throw conflict('O modelo selecionado precisa estar aprovado neste canal.')
  if (template.unavailable_reason) throw conflict(`Este modelo não pode ser enviado: ${template.unavailable_reason}`)
  return (await prepareTemplateMessage(env,b.workspace_id,b.channel_id,choice)).message
}
function permission(adapter: ChannelAdapter, recipient: Recipient, now: number): CanSend {
  return adapter.canSend({ optedIn: !!recipient.opted_in && recipient.contact_status === 'subscribed',
    windowExpiresAt: recipient.window_expires_at, humanWindowExpiresAt: recipient.human_window_expires_at,
    windowMessagesSent: recipient.window_messages_sent, blocked: recipient.blocked_at !== null }, now, 'broadcast')
}
/** Opting out of the provider's marketing only stops marketing: a model of another category (utility, authentication) still goes. */
const isMarketing = (message: OutboundMessage) => message.kind === 'template' && message.category === 'marketing'
function allowed(mode: CanSend, message: OutboundMessage, profile: ChannelProfile) {
  return mode.ok || (message.kind === 'template' && mode.reason === 'outside_window' && profile.templates?.required === 'outside_window')
}
/** The type picked on the screen: it fixes what the content may be. Channels with no window have no type to pick. */
function assertWindowKind(kind: WindowKind, profile: ChannelProfile, hasTemplate: boolean) {
  if (kind === 'automatic') return
  if (!profile.window) throw new HTTPException(400, { message: 'Este canal não tem janela de 24 horas; o tipo da transmissão não se aplica.' })
  if (kind === 'in_window' && hasTemplate) throw new HTTPException(400, { message: 'Dentro da janela de 24h a mensagem é texto livre; para usar um modelo aprovado, escolha Fora da janela / promocional.' })
  if (kind === 'promotional' && !hasTemplate) throw new HTTPException(400, { message: 'Fora da janela de 24h só é possível enviar um modelo aprovado; escolha o modelo.' })
}
const recipientSelection = `SELECT cc.id AS contact_channel_id,cc.contact_id,cc.external_user_id,cc.opted_in,
  c.status AS contact_status,cc.window_expires_at,cc.human_window_expires_at,cc.identity_kind,cc.window_messages_sent,cc.marketing_blocked_at,cc.broadcast_opt_in,cc.blocked_at
  FROM contact_channels cc JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id`
async function validateAudience(env: Env, workspace: string, audience: BroadcastInput['audience']) {
  const ch = await channel(env,workspace,audience.channel_id)
  if (ch.type !== audience.channel) throw new HTTPException(400, { message: 'O canal selecionado não corresponde ao tipo informado.' })
  assertCanBroadcast(ch)
  if (audience.tag !== 'all' && !await env.DB.prepare('SELECT id FROM tags WHERE workspace_id=? AND id=?').bind(workspace,audience.tag).first()) {
    throw new HTTPException(404, { message: 'Etiqueta não encontrada.' })
  }
  await audienceFilter(env,workspace,audience)
  return ch
}
async function audienceFilter(env:Pick<Env,'DB'>,workspace:string,audience:Pick<BroadcastInput['audience'],'segment_id'>) {
  if (!audience.segment_id) return {sql:'1',values:[]}
  return savedSegmentSql(env.DB,workspace,audience.segment_id)
}
async function audienceRows(env: Env, principal: Principal, audience: BroadcastInput['audience'], template?: BroadcastInput['template'], windowKind: WindowKind = 'automatic') {
  const ws = principal.workspaceId
  // Tudo que não depende do resultado de outra leitura sai na mesma onda: canal, etiqueta, segmento (compilado uma vez só),
  // adaptador, ficha e modelo. Os erros continuam na ordem de antes (canal, etiqueta, segmento, adaptador, ficha, modelo):
  // cada promessa é esperada em sequência, e nenhuma delas fica sem tratamento se uma anterior falhar.
  const quiet = <T>(promise: Promise<T>) => { promise.catch(() => undefined); return promise }
  const channelRow = quiet(channel(env, ws, audience.channel_id))
  const tagRow = quiet(audience.tag === 'all' ? Promise.resolve<Record<string, unknown> | null>({}) : env.DB.prepare('SELECT id FROM tags WHERE workspace_id=? AND id=?').bind(ws, audience.tag).first())
  const segmentSql = quiet(audienceFilter(env, ws, audience))
  const adapterP = quiet(connectionAdapter(env, ws, audience.channel_id, audience.channel, { secrets: false }))
  const profileP = quiet(profileOf(env, ws, audience.channel_id))
  const selectedP = quiet(windowKind !== 'in_window' && template
    ? env.DB.prepare("SELECT name_human,category FROM message_templates WHERE workspace_id=? AND channel_id=? AND id=? AND status='approved' AND unavailable_reason IS NULL")
      .bind(ws, audience.channel_id, template.id).first<{ name_human: string; category: TemplateCategory }>()
    : Promise.resolve(null))
  const ch = await channelRow
  if (ch.type !== audience.channel) throw new HTTPException(400, { message: 'O canal selecionado não corresponde ao tipo informado.' })
  assertCanBroadcast(ch)
  if (!await tagRow) throw new HTTPException(404, { message: 'Etiqueta não encontrada.' })
  const segment = await segmentSql
  const rows = await env.DB.prepare(`${recipientSelection} WHERE cc.workspace_id=? AND cc.channel_id=?
    AND (?='all' OR EXISTS(SELECT 1 FROM contact_tags t WHERE t.workspace_id=cc.workspace_id AND t.contact_id=cc.contact_id AND t.tag_id=?)) AND (${audience.email_filter ? emailFilterSql(audience.email_filter) : '1'}) AND (${segment.sql}) ORDER BY cc.contact_id,cc.id`)
    .bind(ws,audience.channel_id,audience.tag,audience.tag,...segment.values).all<Recipient>()
  const adapter = await adapterP, profile = await profileP, now = Date.now()
  // Eligibility depends on the approved model/connection, not on draft parameter values still being edited.
  let message:OutboundMessage={kind:'text',text:''}
  if (windowKind === 'in_window') template = undefined
  if (windowKind === 'promotional' && !template) return { all: rows.results, eligible: [] as Recipient[] }
  if (template) {
    const selected = await selectedP
    if (!profile.templates || !selected) throw conflict('O modelo selecionado precisa estar aprovado nesta conexão.')
    message={kind:'template',templateId:selected.name_human,category:selected.category,params:{}}
  }
  return { all: rows.results, eligible: rows.results.filter(r => !(r.marketing_blocked_at && isMarketing(message)) && allowed(permission(adapter,r,now),message,profile) && (!profile.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.external_user_id))) }
}
export async function estimateBroadcastAudience(env: Env, principal: Principal, audience: BroadcastInput['audience'], template?: BroadcastInput['template'], windowKind: WindowKind = 'automatic') {
  authorize(principal,'automation:read')
  const { all, eligible } = await audienceRows(env,principal,audience,template,windowKind)
  // Contatos únicos, a mesma base da lista da prévia: quem tem duas linhas no canal conta uma vez.
  const unique = (rows: Recipient[]) => new Set(rows.map(r => r.contact_id)).size
  return { count: unique(all), eligible: unique(eligible) }
}
/** Uma página de quem receberia (os mesmos contatos únicos elegíveis que a prévia conta), só nome e foto. */
export async function listAudienceContacts(env: Env, principal: Principal, audience: BroadcastInput['audience'], template?: BroadcastInput['template'], windowKind: WindowKind = 'automatic', page = 1, limit = 20) {
  authorize(principal,'automation:read')
  const { eligible } = await audienceRows(env,principal,audience,template,windowKind)
  const ids = [...new Set(eligible.map(r => r.contact_id))], slice = ids.slice((page-1)*limit,page*limit)
  const found = slice.length ? await env.DB.prepare(`SELECT id,first_name,last_name,profile_pic_url FROM contacts WHERE workspace_id=? AND id IN (${slice.map(() => '?').join(',')})`).bind(principal.workspaceId,...slice).all<{id:string;first_name:string|null;last_name:string|null;profile_pic_url:string|null}>() : { results: [] }
  const byId = new Map(found.results.map(row => [row.id,row]))
  return { total: ids.length, page, limit, contacts: slice.map(id => { const row = byId.get(id); return { id, name: [row?.first_name,row?.last_name].filter(Boolean).join(' ') || 'Sem nome', photo: row?.profile_pic_url ?? null } }) }
}
export async function broadcastOptions(env: Env, principal: Principal) {
  authorize(principal,'automation:read')
  const workspace = principal.workspaceId
  const [channels,tags,templates,segments] = await Promise.all([
    env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND ${stateInSql(SENDING_STATES)} AND type IN (${broadcastKinds().map(() => '?').join(',')}) ORDER BY coalesce(display_name,type)`).bind(workspace, ...broadcastKinds()).all<ConnectionRow>(),
    env.DB.prepare('SELECT id AS value,name AS label FROM tags WHERE workspace_id=? ORDER BY name').bind(workspace).all(),
    env.DB.prepare("SELECT id,channel_id,name_human AS name,language_code AS language,body,header_type,header_text,buttons FROM message_templates WHERE workspace_id=? AND status='approved' AND unavailable_reason IS NULL ORDER BY name_human").bind(workspace).all(),
    env.DB.prepare('SELECT id,name FROM segments WHERE workspace_id=? ORDER BY name,id LIMIT 200').bind(workspace).all(),
  ])
  // Only connections whose own provider can send a broadcast are offered. A ficha sai da própria linha lida (sem outra ida por conexão).
  const sendable = channels.results.filter(row => canBroadcast(row.type, row.provider)).map(row => ({ id: row.id, value: row.type, label: row.display_name ?? row.type, profile: connectionFromRow(row).profile }))
  return { channels: sendable, tags: [{ value: 'all', label: 'Todos os contatos do canal' },...tags.results], templates: templates.results, segments: segments.results,
    timezones: ['America/Sao_Paulo','America/Manaus','America/Recife','Europe/Lisbon','UTC'] }
}
async function broadcastEmailMetrics(env: Pick<Env,'DB'>, b: Stored) {
  const [result,denominator]=await Promise.all([env.DB.prepare(`WITH selected AS (
      SELECT rowid AS ordering,* FROM email_messages WHERE workspace_id=? AND json_extract(metadata,'$.source.broadcastId')=?
    ), first_node AS (SELECT json_extract(metadata,'$.source.nodeId') AS node FROM selected ORDER BY created_at,ordering LIMIT 1)
    SELECT count(DISTINCT CASE WHEN e.type='delivered' THEN e.message_id END) AS delivered,
      count(DISTINCT CASE WHEN e.type='opened' THEN e.contact_id END) AS opened,
      count(DISTINCT CASE WHEN e.type='clicked' AND json_extract(m.metadata,'$.source.nodeId')=(SELECT node FROM first_node) THEN e.contact_id END) AS clicked
      FROM selected m JOIN email_events e ON e.workspace_id=m.workspace_id AND e.message_id=m.id`)
    .bind(b.workspace_id,b.id).first<{delivered:number;opened:number;clicked:number}>(),
  env.DB.prepare(`SELECT count(DISTINCT contact_id) AS n FROM email_messages WHERE workspace_id=? AND status='sent' AND json_extract(metadata,'$.source.broadcastId')=?
    AND json_extract(metadata,'$.source.nodeId')=(SELECT json_extract(metadata,'$.source.nodeId') FROM email_messages WHERE workspace_id=? AND json_extract(metadata,'$.source.broadcastId')=? ORDER BY created_at,rowid LIMIT 1)`)
    .bind(b.workspace_id,b.id,b.workspace_id,b.id).first<{n:number}>()])
  return {...result,ctr:denominator?.n?(result?.clicked ?? 0)/denominator.n:0}
}
/** Mensagens da cópia na ordem do fluxo (a partir do primeiro nó), cada uma com o resumo do que a pessoa vê. */
function copiedMessages(b: Stored) {
  if (!b.copied_graph || !b.first_node_id) return []
  const graph=validateGraph(JSON.parse(b.copied_graph)),byId=new Map(graph.nodes.map(n=>[n.id,n]))
  const order=[b.first_node_id],seen=new Set(order)
  for (let i=0;i<order.length;i++) for (const edge of graph.edges.filter(e=>e.from===order[i])) if (!seen.has(edge.to)) { seen.add(edge.to);order.push(edge.to) }
  return order.map(nodeId=>byId.get(nodeId)!).filter(node=>messageNodeTypes.includes(node.type)).map(node=>{
    const blocks=messageSchema.safeParse(node.config).data?.blocks ?? [],text=blocks.find(block=>block.kind==='text'),media=blocks.find(block=>block.kind==='media')
    const summary=text && text.kind==='text' ? text.text.replace(/\s+/g,' ').trim().slice(0,80) : media && media.kind==='media' ? mediaLabels[media.media] : blocks.some(isCards) ? 'Galeria de cartões' : 'Mensagem'
    return {node_id:node.id,summary}
  })
}
/**
 * Números de cada mensagem da cópia, por contato único. A primeira usa os mesmos números do total (enviadas, entregues, lidas e os cliques do CTR);
 * as seguintes vêm do que o fluxo registrou por nó (envio, recibos do canal e cliques nos botões daquele nó).
 */
type PerMessageRaw = { events: {node_id:string;type:'sent'|'delivered'|'read';n:number}[]; clicks: {node_id:string;n:number}[] }
/** As duas leituras por nó (só quando a cópia tem 2+ mensagens), prontas para sair junto com as do total. */
function perMessageRaw(env: Pick<Env,'DB'>, b: Stored): Promise<PerMessageRaw | undefined> {
  if (copiedMessages(b).length<2) return Promise.resolve(undefined)
  return Promise.all([
    env.DB.prepare(`SELECT ne.node_id,ne.type,count(DISTINCT ne.contact_id) AS n FROM node_events ne
    JOIN broadcast_recipients r ON r.workspace_id=ne.workspace_id AND r.run_id=ne.flow_run_id
    WHERE r.workspace_id=? AND r.broadcast_id=? AND r.status='sent' AND ne.type IN ('sent','delivered','read') GROUP BY ne.node_id,ne.type`)
      .bind(b.workspace_id,b.id).all<{node_id:string;type:'sent'|'delivered'|'read';n:number}>(),
    env.DB.prepare(`SELECT t.node_id,count(DISTINCT cc.contact_id) AS n FROM flow_clicks f
    JOIN button_tokens t ON t.run_id=f.run_id AND t.token=f.token
    JOIN broadcast_recipients r ON r.run_id=f.run_id AND r.workspace_id=t.workspace_id
    JOIN contact_channels cc ON cc.workspace_id=r.workspace_id AND cc.id=r.contact_channel_id
    WHERE r.workspace_id=? AND r.broadcast_id=? AND r.status='sent' GROUP BY t.node_id`).bind(b.workspace_id,b.id).all<{node_id:string;n:number}>(),
  ]).then(([events,clicks]) => ({ events: events.results, clicks: clicks.results }))
}
function perMessageMetrics(b: Stored, raw: PerMessageRaw | undefined, first: {sent:number;delivered:number;read:number;clicked:number}) {
  const messages=copiedMessages(b)
  if (messages.length<2 || !raw) return undefined
  const count=(node:string,type:'sent'|'delivered'|'read')=>raw.events.find(row=>row.node_id===node && row.type===type)?.n ?? 0
  return messages.map(({node_id,summary},index)=>index===0
    ? {node_id,summary,sent:first.sent,delivered:first.delivered,read:first.read,clicked:first.clicked}
    : {node_id,summary,sent:count(node_id,'sent'),delivered:count(node_id,'delivered'),read:count(node_id,'read'),clicked:raw.clicks.find(row=>row.node_id===node_id)?.n ?? 0})
}
async function dto(env: Env, b: Stored) {
  // Todas as leituras do painel da transmissão saem numa onda só (antes eram oito em fila); só as métricas de e-mail
  // de um canal que não guarda e-mail no conteúdo esperam a ficha da conexão.
  const [metric, actual, clicked, sentContacts, progress, raw, profile, emailEarly, pauseDetail] = await Promise.all([
    env.DB.prepare(`SELECT count(*) AS total,
    coalesce(sum(status='sent'),0) AS sent,coalesce(sum(status IN ('queued','sending')),0) AS queued,
    coalesce(sum(status='skipped'),0) AS skipped,coalesce(sum(status='skipped' AND reason='outside_window'),0) AS outside_window,coalesce(sum(status='failed'),0) AS failed,
    coalesce(sum(status='uncertain'),0) AS uncertain FROM broadcast_recipients WHERE workspace_id=? AND broadcast_id=?`)
      .bind(b.workspace_id,b.id).first<Record<string,number>>(),
    // A read receipt implies delivery. Providers without receipts never report delivered/read: do not fabricate them.
    env.DB.prepare(`SELECT
    count(DISTINCT CASE WHEN (json_extract(m.content,'$.status') IN ('delivered','read') OR m.delivery_status IN ('delivered','read')) THEN json_extract(m.content,'$.broadcast.recipient') END) AS delivered,
    count(DISTINCT CASE WHEN (json_extract(m.content,'$.status')='read' OR m.delivery_status='read') THEN json_extract(m.content,'$.broadcast.recipient') END) AS read,
    count(DISTINCT CASE WHEN json_extract(m.content,'$.status')='failed' THEN json_extract(m.content,'$.broadcast.recipient') END) AS failed
    FROM messages m JOIN broadcast_recipients r ON r.workspace_id=m.workspace_id AND r.broadcast_id=?
      AND r.contact_channel_id=json_extract(m.content,'$.broadcast.recipient') AND r.status='sent'
    WHERE m.workspace_id=? AND json_extract(m.content,'$.broadcast.id')=?`)
      .bind(b.id,b.workspace_id,b.id).first<{delivered:number;read:number;failed:number}>(),
    env.DB.prepare(`SELECT count(DISTINCT contact_id) AS n FROM (SELECT cc.contact_id FROM flow_clicks f
    JOIN button_tokens t ON t.run_id=f.run_id AND t.token=f.token
    JOIN broadcast_recipients r ON r.run_id=f.run_id AND r.workspace_id=t.workspace_id
    JOIN contact_channels cc ON cc.workspace_id=r.workspace_id AND cc.id=r.contact_channel_id
    WHERE r.workspace_id=? AND r.broadcast_id=? AND r.status='sent' AND t.node_id=? AND t.step_index=0
    UNION ALL SELECT cc.contact_id FROM broadcast_links l
    JOIN broadcast_recipients r ON r.workspace_id=l.workspace_id AND r.broadcast_id=l.broadcast_id AND r.contact_channel_id=l.contact_channel_id
    JOIN contact_channels cc ON cc.workspace_id=r.workspace_id AND cc.id=r.contact_channel_id
    WHERE l.workspace_id=? AND l.broadcast_id=? AND l.clicked_at IS NOT NULL AND r.status='sent')`)
      .bind(b.workspace_id,b.id,b.first_node_id ?? broadcastStepId,b.workspace_id,b.id).first<{n:number}>(),
    env.DB.prepare(`SELECT count(DISTINCT cc.contact_id) AS n FROM broadcast_recipients r
    JOIN contact_channels cc ON cc.workspace_id=r.workspace_id AND cc.id=r.contact_channel_id
    WHERE r.workspace_id=? AND r.broadcast_id=? AND r.status='sent'`)
      .bind(b.workspace_id,b.id).first<{n:number}>(),
    // Envio assíncrono parado: em envio, sem pausa, e nenhum destinatário mudou nos últimos 10 minutos; mostra onde parou.
    b.status === 'sending' && b.paused_at === null ? env.DB.prepare(`SELECT count(*) AS total,coalesce(sum(status NOT IN ('queued','sending')),0) AS done,max(updated_at) AS last
    FROM broadcast_recipients WHERE workspace_id=? AND broadcast_id=?`).bind(b.workspace_id,b.id).first<{ total: number; done: number; last: number | null }>() : Promise.resolve(null),
    perMessageRaw(env,b),
    b.email_content ? Promise.resolve(null) : profileOf(env,b.workspace_id,b.channel_id),
    b.email_content ? broadcastEmailMetrics(env,b) : Promise.resolve(null),
    // Credencial recusada (401 do provedor de token colado): o motivo que a pessoa lê é o que o adaptador escreveu na conexão, com o nome do provedor.
    b.pause_reason === 'token_refused' ? env.DB.prepare('SELECT status_detail FROM channels WHERE workspace_id=? AND id=?').bind(b.workspace_id,b.channel_id).first<string|null>('status_detail') : Promise.resolve(null),
  ])
  const stalled = progress && progress.total > progress.done && progress.last !== null && Date.now() - progress.last > 600_000
    ? { percent: Math.floor(progress.done * 100 / progress.total), since: iso(progress.last) } : null
  const messages = perMessageMetrics(b,raw,{sent:metric?.sent ?? 0,delivered:actual?.delivered ?? 0,read:actual?.read ?? 0,clicked:clicked?.n ?? 0})
  const emailMetrics = b.email_content ? emailEarly : profile?.email ? await broadcastEmailMetrics(env,b) : null
  const copied = b.copied_graph ? JSON.parse(b.copied_graph) : undefined
  return { flow:copied ?? (b.flow ? JSON.parse(b.flow) : undefined),copied_graph:copied,graph:copied,automation_id:b.automation_id,source_automation_id:b.source_automation_id,first_node_id:b.first_node_id,email:b.email_content ? JSON.parse(b.email_content) : undefined,id:b.id,workspace_id:b.workspace_id,name:b.name,content:b.content,
    audience:{...JSON.parse(b.audience_filter),channel:b.channel_type,channel_id:b.channel_id},
    status:b.paused_at !== null ? 'paused' : b.status,started:b.started_at !== null,scheduled_at:iso(b.scheduled_at),scheduled_local:b.scheduled_local,timezone:b.timezone,
    template:b.template ? JSON.parse(b.template) : undefined,window_kind:b.window_kind, updated_at:iso(b.updated_at),pause_reason:b.pause_reason,...(pauseDetail ? {pause_detail:pauseDetail} : {}),retry_at:iso(b.retry_at),stalled,
    metrics:{...metric,delivered:actual?.delivered ?? 0,read:actual?.read ?? 0,failed:(metric?.failed ?? 0)+(actual?.failed ?? 0),clicked:clicked?.n ?? 0,ctr:sentContacts?.n ? (clicked?.n ?? 0)/sentContacts.n : 0,...(messages ? {messages} : {}),...emailMetrics} }
}
export async function listBroadcasts(env: Env, principal: Principal, filter: { status?: string; search?: string } = {}) {
  authorize(principal,'automation:read')
  const rows = await env.DB.prepare(`${selection} WHERE b.workspace_id=? AND (? IS NULL OR b.name LIKE ? ESCAPE '\\') ORDER BY b.updated_at DESC,b.id LIMIT 200`)
    .bind(principal.workspaceId,filter.search ?? null,`%${(filter.search ?? '').replace(/[\\%_]/g,'\\$&')}%`).all<Stored>()
  const result = await Promise.all(rows.results.map(b => dto(env,fromFlow(b))))
  return result.filter(b => !filter.status || b.status === filter.status)
}
export async function getBroadcast(env: Env, principal: Principal, broadcastId: string) {
  authorize(principal,'automation:read')
  const b = await stored(env,principal.workspaceId,broadcastId)
  // A failed receipt arrives after the send was confirmed: the recipient was "sent", then Meta reported why it did not arrive.
  const recipients = await env.DB.prepare(`SELECT r.contact_channel_id,cc.contact_id,trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) AS name,r.status,r.reason,r.sent_at,
      (SELECT json_extract(m.content,'$.deliveryErrorCode') FROM messages m WHERE m.workspace_id=r.workspace_id
        AND json_extract(m.content,'$.broadcast.id')=r.broadcast_id AND json_extract(m.content,'$.broadcast.recipient')=r.contact_channel_id
        AND m.delivery_status='failed' LIMIT 1) AS receipt_error
    FROM broadcast_recipients r
    JOIN contact_channels cc ON cc.workspace_id=r.workspace_id AND cc.id=r.contact_channel_id
    LEFT JOIN contacts ct ON ct.workspace_id=cc.workspace_id AND ct.id=cc.contact_id
    WHERE r.workspace_id=? AND r.broadcast_id=? ORDER BY r.contact_channel_id LIMIT 200`).bind(principal.workspaceId,broadcastId).all<{contact_channel_id:string;contact_id:string;name:string;status:string;reason:string|null;sent_at:number|null;receipt_error:string|null}>()
  return { ...await dto(env,b),recipients:recipients.results.map(({receipt_error,...r}) => r.status==='sent' && receipt_error ? { ...r,status:'failed',reason:receipt_error } : r) }
}
export async function enqueueBroadcast(env: Env, workspaceId: string, broadcastId: string, delaySeconds = 0) {
  if (!env.INBOUND) throw new HTTPException(503, { message: 'A fila de envio não está configurada.' })
  await env.INBOUND.send({ kind:'broadcast', workspaceId, broadcastId }, { delaySeconds:Math.min(43200,Math.max(0,Math.ceil(delaySeconds))) })
  await env.DB.prepare('UPDATE broadcasts SET enqueued_at=? WHERE workspace_id=? AND id=?').bind(Date.now(),workspaceId,broadcastId).run()
}
/**
 * O fluxo do mapa tem um início só (o passo sem ligação de entrada), e ele é uma mensagem.
 * Um passo de texto puro continua sendo o envio direto; qualquer outra forma é uma cópia, que o executor de fluxo percorre.
 */
function planFlow(raw: unknown) {
  const full = validateGraph(raw), entries = new Set(full.nodes.filter(n => ['trigger','starting_step'].includes(n.type)).map(n => n.id))
  // O início é o envio: o gatilho de uma cópia de automação não entra.
  const graph = entries.size ? { ...full, nodes: full.nodes.filter(n => !entries.has(n.id)), edges: full.edges.filter(e => !entries.has(e.from) && !entries.has(e.to)) } : full
  const steps = graph.nodes.filter(n => !['note','comment'].includes(n.type))
  const starts = steps.filter(n => !graph.edges.some(e => e.to === n.id))
  if (starts.length !== 1) throw new HTTPException(400,{message:'Ligue os passos: o envio começa em um passo só.'})
  const first = starts[0]
  if (!messageNodeTypes.includes(first.type)) throw new HTTPException(400,{message:'O envio precisa começar por uma mensagem.'})
  const blocks = messageSchema.parse(first.config).blocks, text = blocks.find(block=>block.kind==='text')
  const content = text && text.kind==='text' ? text.text : blocks.some(block=>block.kind==='media') ? 'Anexo de mídia' : 'Mensagem'
  const plain = steps.length===1 && first.id===broadcastStepId && graph.edges.length===0 && blocks.length===1 && blocks[0].kind==='text'
  return { graph, first, content, plain }
}
/** A cópia do fluxo (a automação escondida e o ponteiro da transmissão), para o mesmo lote que grava a transmissão.
 * `when` é a condição de edição sobre a linha da transmissão: a cópia só fica quando a gravação da transmissão também fica. */
function copyStatements(env: Env, workspace: string, broadcastId: string, name: string, plan: ReturnType<typeof planFlow>, when = { sql: '1', values: [] as unknown[] }) {
  const graph = JSON.stringify(plan.graph), copyId = `broadcast-${broadcastId}`
  return [
    env.DB.prepare(`INSERT INTO automations(id,workspace_id,name,status,draft_graph,deleted_at) SELECT ?,?,?,'stopped',?,?
      WHERE EXISTS (SELECT 1 FROM broadcasts WHERE workspace_id=? AND id=? AND ${when.sql}) ON CONFLICT(id) DO UPDATE SET draft_graph=excluded.draft_graph,name=excluded.name`)
      .bind(copyId,workspace,name,graph,Date.now(),workspace,broadcastId,...when.values),
    env.DB.prepare(`UPDATE broadcasts SET copied_graph=?,flow=?,first_node_id=?,automation_id=? WHERE workspace_id=? AND id=? AND ${when.sql}`)
      .bind(graph,graph,plan.first.id,copyId,workspace,broadcastId,...when.values),
  ]
}
export async function saveBroadcast(env: Env, principal: Principal, raw: unknown) {
  authorize(principal,'edit')
  const parsed = broadcastInput.parse(raw), workspace = principal.workspaceId, now = Date.now()
  // E-mail e modelo aprovado guardam o fluxo de um passo; um fluxo de vários passos nesses tipos é recusado, não descartado em silêncio.
  if (parsed.flow && (parsed.template || parsed.email) && planFlow(parsed.flow).graph.nodes.length > 1) {
    throw new HTTPException(400,{message:'Transmissão de e-mail ou de modelo tem um passo só; para vários passos, use mensagem de texto.'})
  }
  const plan = parsed.flow && !parsed.template && !parsed.email ? planFlow(parsed.flow) : null
  const input = plan ? { ...parsed, content: plan.content } : parsed
  if (!input.template && input.status !== 'draft') await validateMessageVariables(env.DB, workspace, [input.content])
  const ch = await validateAudience(env,workspace,input.audience)
  try { new Intl.DateTimeFormat('pt-BR',{timeZone:input.timezone}).format() } catch { throw new HTTPException(400,{message:'Fuso inválido.'}) }
  const scheduledAt = input.status === 'scheduled' ? Date.parse(input.scheduled_at ?? '') : null
  if (input.status === 'scheduled' && (!Number.isFinite(scheduledAt) || scheduledAt! <= now)) throw new HTTPException(400,{message:'O agendamento precisa estar no futuro.'})
  if (!input.email && input.content.length>2000) throw new HTTPException(400,{message:'Use até 2.000 caracteres nesta mensagem.'})
  if (input.email && input.template) throw new HTTPException(400,{message:'Escolha e-mail ou modelo, um conteúdo por envio.'})
  if (!input.template && !input.content.trim()) throw new HTTPException(400,{message:'Escreva a mensagem ou selecione um modelo.'})
  const candidate = { workspace_id:workspace,channel_id:input.audience.channel_id,
    content:input.content,email_content:input.email ? JSON.stringify(input.email) : null,template:input.template ? JSON.stringify(input.template) : null }
  const message = await messageFor(env,candidate), adapter = await connectionAdapter(env,workspace,input.audience.channel_id,ch.type,{secrets:false})
  assertWindowKind(input.window_kind,await profileOf(env,workspace,input.audience.channel_id),!!input.template)
  const fitted = adapter.fit(message,await profileOf(env,workspace,input.audience.channel_id))
  if ('ok' in fitted) throw new HTTPException(400,{message:'O conteúdo não é compatível com este canal.'})
  if (input.status !== 'draft') {
    await assertChannel(env,workspace,input.audience.channel_id)
    if (!env.INBOUND) throw new HTTPException(503,{message:'Configure a fila antes de enviar.'})
  }
  const broadcastId = input.id ?? crypto.randomUUID()
  if (input.id) {
    const old = await stored(env,workspace,broadcastId)
    if (old.copied_graph && input.template) throw conflict('A cópia de automação usa as mensagens do próprio fluxo.')
    if (!['draft','scheduled'].includes(old.status) || old.started_at !== null) throw conflict('O envio já começou e não pode ser editado.')
    const asCopy = !!plan && (!plan.plain || !!old.copied_graph)
    let copiedGraph=old.copied_graph
    if (plan && asCopy) copiedGraph=JSON.stringify(plan.graph)
    else if (copiedGraph && old.content!==input.content) {
      const graph=validateGraph(JSON.parse(copiedGraph)),first=graph.nodes.find(n=>n.id===old.first_node_id)!
      let replaced=false
      first.config.blocks=messageSchema.parse(first.config).blocks.map(block=>block.kind==='text' && !replaced ? (replaced=true,{...block,text:input.content}) : block)
      copiedGraph=JSON.stringify(graph)
    }
    if (copiedGraph) {
      await validateCopiedGraph(env,workspace,validateGraph(JSON.parse(copiedGraph)),adapter,await profileOf(env,workspace,input.audience.channel_id))
      if (input.status!=='draft' && !env.FLOW_RUN) throw new HTTPException(503,{message:'Configure o executor de automações antes de enviar.'})
    }
    // Cópia do fluxo e transmissão no mesmo lote, sob a mesma condição de edição: ficam as duas ou nenhuma. A cópia vem antes porque a
    // condição é lida na linha como estava antes do lote; a gravação da transmissão vem por último e devolve se valeu.
    const editable = `status IN ('draft','scheduled') AND started_at IS NULL AND (lease_until IS NULL OR lease_until<=?)`
    const [change] = (await env.DB.batch([
      ...(plan && asCopy ? copyStatements(env,workspace,broadcastId,input.name,plan,{sql:editable,values:[now]}) : []),
      env.DB.prepare(`UPDATE broadcasts SET name=?,channel_id=?,audience_filter=?,status=?,scheduled_at=?,content=?,email_content=?,template=?,window_kind=?,timezone=?,scheduled_local=?,copied_graph=?,flow=?,enqueued_at=NULL,updated_at=?
      WHERE workspace_id=? AND id=? AND ${editable} RETURNING id`)
      .bind(input.name,input.audience.channel_id,JSON.stringify({tag:input.audience.tag,...(input.audience.email_filter?{email_filter:input.audience.email_filter}:{}),...(input.audience.segment_id?{segment_id:input.audience.segment_id}:{}),...(input.audience.conditions?.length?{conditions:input.audience.conditions}:{})}),input.status,scheduledAt,input.content,candidate.email_content,candidate.template,input.window_kind,input.timezone,input.scheduled_local,copiedGraph,copiedGraph ?? broadcastFlow(input.content,candidate.email_content,candidate.template),now,workspace,broadcastId,now),
    ])).at(-1)!.results
    if (!change) throw conflict('O envio já está sendo preparado.')
  } else {
    if (plan && !plan.plain) {
      await validateCopiedGraph(env,workspace,plan.graph,adapter,await profileOf(env,workspace,input.audience.channel_id))
      if (input.status!=='draft' && !env.FLOW_RUN) throw new HTTPException(503,{message:'Configure o executor de automações antes de enviar.'})
    }
    // Transmissão e cópia do fluxo no mesmo lote: uma cópia que falha não deixa a transmissão agendada só com o texto.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO broadcasts(id,workspace_id,name,channel_id,audience_filter,status,scheduled_at,content,email_content,template,window_kind,timezone,scheduled_local,flow,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(broadcastId,workspace,input.name,input.audience.channel_id,JSON.stringify({tag:input.audience.tag,...(input.audience.email_filter?{email_filter:input.audience.email_filter}:{}),...(input.audience.segment_id?{segment_id:input.audience.segment_id}:{}),...(input.audience.conditions?.length?{conditions:input.audience.conditions}:{})}),input.status,scheduledAt,input.content,candidate.email_content,candidate.template,input.window_kind,input.timezone,input.scheduled_local,broadcastFlow(input.content,candidate.email_content,candidate.template),now,now),
      ...(plan && !plan.plain ? copyStatements(env,workspace,broadcastId,input.name,plan) : []),
    ])
  }
  if (input.status !== 'draft') await enqueueBroadcast(env,workspace,broadcastId,scheduledAt ? (scheduledAt-now)/1000 : 0)
  return dto(env,await stored(env,workspace,broadcastId))
}
/** Copies use the same block order and effective media limits as the automation executor. */
async function validateCopiedGraph(env: Env,workspace: string,graph: ReturnType<typeof validateGraph>,adapter: ChannelAdapter,profile: ChannelProfile) {
  for (const node of graph.nodes.filter(n=>messageNodeTypes.includes(n.type))) {
    const config=messageSchema.parse(node.config)
    if (config.blocks.some(block=>block.kind==='quick_reply')) throw conflict('Transmissões não enviam respostas rápidas; troque por botões na cópia.')
    await validateMessageVariables(env.DB,workspace,config.blocks.flatMap(block=>isCards(block)?cardTexts(block):[block.kind==='text'?block.text:block.kind==='button'?block.label:block.kind==='media'?block.url:'']))
    const buttons=config.blocks.filter(block=>block.kind==='button').map(block=>block.action.type==='url'
      ? {type:'url' as const,title:block.label,url:block.action.url}:{type:'postback' as const,title:block.label,id:`b:${'0'.repeat(24)}`})
    const sendable=mergeLeadText(config.blocks.filter(block=>block.kind==='text' || block.kind==='media' || isCards(block)),profile)
    if (buttons.length && sendable.at(-1)?.kind==='media') sendable.push({kind:'text',text:'Escolha uma opção:'})
    for (const [index,block] of sendable.entries()) {
      let message:OutboundMessage
      if (block.kind==='media') {
        const media=await storedMedia(env,workspace,block),error=mediaError(media,[profile])
        if (error) throw conflict(error)
        message={kind:'media',media:media.media,url:messageVariables(media.url).length?'https://media.example.test/variable':media.url,size:media.size,mime:media.mime}
      } else if (isCards(block)) message=cardsMessage(block)
      else message={kind:'text',text:block.text,...(index===sendable.length-1 && buttons.length?{buttons}:{})}
      if ('ok' in adapter.fit(message,profile)) throw conflict('O conteúdo da cópia não é compatível com a ficha desta conexão.')
    }
  }
}
/** Starts from a real draft/publication and freezes all nodes, edges and button actions. */
export async function createBroadcastFromAutomation(env: Env, principal: Principal, raw: unknown) {
  authorize(principal,'edit')
  const input = broadcastFromAutomationSchema.parse(raw)
  const source = await env.DB.prepare('SELECT name,draft_graph FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL')
    .bind(principal.workspaceId,input.automation_id).first<{name:string;draft_graph:string}>()
  if (!source) throw new HTTPException(404,{message:'Automação não encontrada.'})
  const graph = validateGraph(JSON.parse(source.draft_graph))
  let first = graph.nodes.find(n=>['trigger','starting_step'].includes(n.type)) ?? graph.nodes[0]
  const visited = new Set<string>()
  while (first && !messageNodeTypes.includes(first.type)) {
    if (visited.has(first.id) || !['trigger','starting_step','note','comment'].includes(first.type)) throw conflict('A automação precisa começar por uma mensagem.')
    visited.add(first.id)
    const edge = graph.edges.find(e=>e.from===first!.id && ['next','then'].includes(e.port))
    first = graph.nodes.find(n=>n.id===edge?.to)!
  }
  if (!first) throw conflict('Escolha uma automação com uma mensagem inicial.')
  const ch = await channel(env,principal.workspaceId,input.channel_id)
  const adapter = await connectionAdapter(env,principal.workspaceId,input.channel_id,ch.type,{secrets:false})
  const profile = await profileOf(env,principal.workspaceId,input.channel_id)
  await validateCopiedGraph(env,principal.workspaceId,graph,adapter,profile)
  const initial=messageSchema.parse(first.config)
  const content=initial.blocks.find(b=>b.kind==='text')?.text ?? (initial.blocks.some(b=>b.kind==='media') ? 'Anexo de mídia' : '')
  const result=await saveBroadcast(env,principal,{name:source.name,content,status:'draft',audience:{tag:'all',channel:ch.type,channel_id:input.channel_id}})
  const copyId=`broadcast-${result.id}`
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automations(id,workspace_id,name,status,draft_graph,deleted_at) VALUES (?,?,?,'stopped',?,?)")
      .bind(copyId,principal.workspaceId,source.name,JSON.stringify(graph),Date.now()),
    env.DB.prepare('UPDATE broadcasts SET copied_graph=?,flow=?,source_automation_id=?,first_node_id=?,automation_id=? WHERE workspace_id=? AND id=?')
      .bind(JSON.stringify(graph),JSON.stringify(graph),input.automation_id,first.id,copyId,principal.workspaceId,result.id),
  ])
  return dto(env,await stored(env,principal.workspaceId,result.id))
}

const testFailureText: Record<string,string> = {
  not_opted_in:'Este contato não aceitou receber mensagens neste canal, então o teste não foi enviado.',
  blocked:'O contato ou o canal bloqueou o recebimento.',
  rate_limited:'O canal atingiu o limite de envios. Aguarde um pouco e tente de novo.',
}
/** Motivo da recusa do canal em português, para o aviso do teste: o detalhe do provedor quando existe, senão o motivo conhecido. */
function testFailure(result: { ok: false; reason?: string; detail?: string }) {
  return result.detail?.trim() || (result.reason && testFailureText[result.reason]) || 'O canal não confirmou o envio de teste.'
}
/** A test uses only the selected contact and the first message; no audience, run, metrics or automation actions are touched. */
export async function testBroadcast(env: Env, principal: Principal, broadcastId: string, raw: unknown) {
  authorize(principal,'edit')
  const input=broadcastTestSchema.parse(raw),b=await stored(env,principal.workspaceId,broadcastId)
  await assertChannel(env,b.workspace_id,b.channel_id)
  const recipient=await env.DB.prepare(`${recipientSelection} WHERE cc.workspace_id=? AND cc.channel_id=? AND cc.contact_id=?`)
    .bind(b.workspace_id,b.channel_id,input.contact_id).first<Recipient>()
  if (!recipient) throw new HTTPException(404,{message:'Contato não encontrado nesta conexão.'})
  const rt=await connectionRuntime(env,b.workspace_id,b.channel_id,{requireConnected:true})
  if (!rt.provider) throw conflict('A conexão não oferece envio de teste.')
  const render=await contactVariableRenderer(env.DB,b.workspace_id,recipient.contact_id)
  const messages:OutboundMessage[]=b.copied_graph ? await firstGraphMessages(env,b,recipient,null) : [await messageFor(env,{...b,id:undefined,content:render(b.content)})]
  for (const message of messages) if (message.kind==='text' && message.email) { delete message.email.source; delete message.email.onOpen; delete message.email.linkActions }
  const mode=permission(rt.adapter,recipient,Date.now())
  const parts:{external_id:string;status:'sent'}[]=[], shown:string[]=[]
  for (const message of messages) {
    if (!allowed(mode,message,rt.connection.profile)) throw conflict('Este contato não está elegível para receber o teste.')
    const fitted=rt.provider.fit(message,rt.connection.profile)
    if ('ok' in fitted) throw conflict('A mensagem não é compatível com esta conexão.')
    for (const part of fitted.messages) {
      // O e-mail não usa credenciais do canal; nos demais, credencial ilegível vira orientação, não erro interno.
      let credentials: Awaited<ReturnType<typeof rt.credentials>>
      try { credentials=await rt.credentials() }
      catch { if (b.channel_type==='email') credentials={} as typeof credentials; else throw conflict('Não foi possível ler as credenciais deste canal. Reconecte o canal em Configurações e tente de novo.') }
      const result=await rt.provider.send({connection:rt.connection,credentials,fetch:rt.fetch,env,intent:'broadcast',target:{kind:'direct',externalUserId:recipient.external_user_id}},part)
      if (!result.ok) throw conflict(testFailure(result))
      parts.push({external_id:String(result.externalId),status:'sent'})
      shown.push(part.kind==='template' ? await templateDisplayText(env,b.workspace_id,b.channel_id,part) : part.kind==='text' && part.email ? `E-mail: ${part.email.subject}` : inboxText(part))
    }
  }
  // The test lands in the contact's conversation, marked as a test (content.broadcast.test), with the provider id of the last part so later receipts match it.
  const conversationId=await ensureConversation(env,b.workspace_id,recipient.contact_id,b.channel_id)
  const messageId=`broadcast-test-${crypto.randomUUID()}`
  const last=parts.at(-1)?.external_id
  await recordMessage(env,{id:messageId,workspaceId:b.workspace_id,conversationId,direction:'out',sender:'automation',text:`[Teste da transmissão] ${shown.join('\n\n')}`,
    status:'sent',...(last ? {externalMessageId:`${b.channel_type}:${b.channel_id}:${recipient.external_user_id}:${last}`} : {})})
  await env.DB.prepare(`UPDATE messages SET source='broadcast',content=json_set(content,'$.broadcast',json(?)) WHERE workspace_id=? AND id=?`)
    .bind(JSON.stringify({id:b.id,test:true}),b.workspace_id,messageId).run()
  return {ok:true as const,test:true as const,conversation_id:conversationId,message_id:messageId,parts}
}
export async function cancelBroadcast(env: Env, principal: Principal, broadcastId: string) {
  authorize(principal,'edit')
  await stored(env,principal.workspaceId,broadcastId)
  const changed=await env.DB.prepare(`UPDATE broadcasts SET status='cancelled',paused_at=NULL,pause_reason=NULL,retry_at=NULL,enqueued_at=NULL
    WHERE workspace_id=? AND id=? AND status='scheduled' AND started_at IS NULL AND (lease_until IS NULL OR lease_until<=?) RETURNING id`)
    .bind(principal.workspaceId,broadcastId,Date.now()).first()
  if (!changed) throw conflict('Somente uma transmissão agendada que ainda não começou pode ser cancelada.')
  return dto(env,await stored(env,principal.workspaceId,broadcastId))
}

/** Apaga rascunho ou agendada que ainda não começou (com a cópia do fluxo e os destinatários); o que já foi enviado fica no histórico. */
export async function deleteBroadcast(env: Env, principal: Principal, broadcastId: string) {
  authorize(principal,'edit')
  const b=await stored(env,principal.workspaceId,broadcastId)
  const removed=await env.DB.prepare(`DELETE FROM broadcasts WHERE workspace_id=? AND id=? AND status IN ('draft','scheduled') AND started_at IS NULL AND (lease_until IS NULL OR lease_until<=?) RETURNING id`)
    .bind(principal.workspaceId,broadcastId,Date.now()).first()
  if (!removed) throw conflict('Só rascunhos e transmissões agendadas que ainda não começaram podem ser excluídos.')
  if (b.automation_id?.startsWith('broadcast-')) await env.DB.prepare('DELETE FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NOT NULL').bind(principal.workspaceId,b.automation_id).run()
  return {ok:true as const}
}

export async function pauseBroadcast(env: Env, principal: Principal, broadcastId: string) {
  authorize(principal,'edit')
  await stored(env,principal.workspaceId,broadcastId)
  const changed = await env.DB.prepare(`UPDATE broadcasts SET paused_at=?,pause_reason='manual',updated_at=? WHERE workspace_id=? AND id=? AND status IN ('sending','scheduled') RETURNING id`)
    .bind(Date.now(),Date.now(),principal.workspaceId,broadcastId).first()
  if (!changed) throw conflict('Somente envios agendados ou em andamento podem ser pausados.')
  return dto(env,await stored(env,principal.workspaceId,broadcastId))
}
export async function resumeBroadcast(env: Env, principal: Principal, broadcastId: string) {
  authorize(principal,'edit')
  const b = await stored(env,principal.workspaceId,broadcastId)
  if (b.paused_at === null) throw conflict('Este envio não está pausado.')
  if (b.retry_at && b.retry_at>Date.now()) throw conflict('Aguarde o prazo informado pelo canal antes de retomar.')
  await assertChannel(env,b.workspace_id,b.channel_id)
  await messageFor(env,b)
  if (!env.INBOUND) throw new HTTPException(503,{message:'A fila não está configurada.'})
  await env.DB.prepare('UPDATE broadcasts SET paused_at=NULL,pause_reason=NULL,retry_at=NULL,enqueued_at=NULL WHERE workspace_id=? AND id=?')
    .bind(b.workspace_id,b.id).run()
  await enqueueBroadcast(env,b.workspace_id,b.id)
  return dto(env,await stored(env,b.workspace_id,b.id))
}

/** Daily existing maintenance cron recovers a failed enqueue; normal scheduling uses delayed Queue messages. */
export async function recoverBroadcastQueue(env: Env) {
  const rows = await env.DB.prepare(`SELECT workspace_id,id,scheduled_at FROM broadcasts WHERE status IN ('scheduled','sending')
    AND paused_at IS NULL AND (enqueued_at IS NULL OR enqueued_at<?) LIMIT 100`)
    .bind(Date.now()-86400000).all<{workspace_id:string;id:string;scheduled_at:number|null}>()
  for (const row of rows.results) await enqueueBroadcast(env,row.workspace_id,row.id,Math.max(0,((row.scheduled_at ?? Date.now())-Date.now())/1000))
}

async function snapshot(env: Env, b: Stored, token: string) {
  const automationId = `broadcast-${b.id}`, versionId = `broadcast-version-${b.id}`
  const graph = b.copied_graph ?? b.flow ?? broadcastFlow(b.content,b.email_content,b.template)
  const tag = JSON.parse(b.audience_filter).tag as string
  const segment=await audienceFilter(env,b.workspace_id,JSON.parse(b.audience_filter))
  // Atomic snapshot at send time, never at schedule time. Internal automation is hidden from ordinary lists.
  // Só vale para quem ainda tem o lease de uma transmissão que não começou nem foi cancelada: um lease que venceu no meio
  // (a pessoa cancelou, ou outra rodada assumiu) não ressuscita a transmissão nem enche a lista de destinatários.
  const claimed = `EXISTS (SELECT 1 FROM broadcasts WHERE workspace_id=? AND id=? AND lease_token=? AND started_at IS NULL AND status IN ('scheduled','sending'))`
  const claim = [b.workspace_id, b.id, token]
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO automations(id,workspace_id,name,status,deleted_at) SELECT ?,?,?,'stopped',? WHERE ${claimed} ON CONFLICT(id) DO NOTHING`)
      .bind(automationId,b.workspace_id,b.name,Date.now(),...claim),
    env.DB.prepare(`INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) SELECT ?,?,?,1,? WHERE ${claimed} ON CONFLICT(id) DO NOTHING`)
      .bind(versionId,b.workspace_id,automationId,graph,...claim),
    env.DB.prepare(`INSERT INTO broadcast_recipients(workspace_id,broadcast_id,contact_channel_id,run_id,updated_at)
      SELECT cc.workspace_id,?,cc.id,?||cc.id,? FROM contact_channels cc JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id
      WHERE cc.workspace_id=? AND cc.channel_id=? AND (${JSON.parse(b.audience_filter).email_filter ? emailFilterSql(JSON.parse(b.audience_filter).email_filter) : '1'}) AND (?='all' OR EXISTS(SELECT 1 FROM contact_tags t
        WHERE t.workspace_id=cc.workspace_id AND t.contact_id=cc.contact_id AND t.tag_id=?)) AND (${segment.sql}) AND ${claimed}
      ON CONFLICT DO NOTHING`).bind(b.id,`broadcast-run-${b.id}-`,Date.now(),b.workspace_id,b.channel_id,tag,tag,...segment.values,...claim),
    env.DB.prepare(`UPDATE broadcasts SET started_at=?,automation_id=?,status='sending' WHERE workspace_id=? AND id=? AND lease_token=?
      AND started_at IS NULL AND status IN ('scheduled','sending')`)
      .bind(Date.now(),automationId,b.workspace_id,b.id,token),
  ])
}
/** Com `run`, a execução do destinatário fecha no mesmo lote, e só se ainda estiver rodando: um estado final que outro escritor
 * gravou nela no meio do envio (o contato saiu ou foi apagado: cancelled) não é sobrescrito. */
async function markRecipient(env: Env,b: Stored,r: Recipient,status: string,reason: string|null = null,run?: 'done'|'failed') {
  const recipient = env.DB.prepare(`UPDATE broadcast_recipients SET status=?,reason=?,sent_at=CASE WHEN ?='sent' THEN coalesce(sent_at,?) ELSE sent_at END,updated_at=?
    WHERE workspace_id=? AND broadcast_id=? AND contact_channel_id=?`).bind(status,reason,status,Date.now(),Date.now(),b.workspace_id,b.id,r.contact_channel_id)
  if (!run) { await recipient.run(); return }
  await env.DB.batch([recipient,moveRun(env.DB,r.run_id,run,{from:['running'],workspaceId:b.workspace_id})])
}
async function recipientContent(env: Env, b: Stored, r: Recipient): Promise<string> {
  if (b.template) return b.content
  if (r.resolved_content !== null) return r.resolved_content
  const content = (await contactVariableRenderer(env.DB, b.workspace_id, r.contact_id))(b.content)
  const saved = await env.DB.prepare(`UPDATE broadcast_recipients SET resolved_content=coalesce(resolved_content,?)
    WHERE workspace_id=? AND broadcast_id=? AND contact_channel_id=? RETURNING resolved_content`)
    .bind(content, b.workspace_id, b.id, r.contact_channel_id).first<{ resolved_content: string }>()
  if (!saved) throw new Error('Destinatário indisponível.')
  r.resolved_content = saved.resolved_content
  return saved.resolved_content
}
/** The inbox copy of a template broadcast: the name and the rendered text; a model that became unavailable since keeps only its name. */
async function broadcastTemplateText(env: Env,b: Stored): Promise<string> {
  const message=await messageFor(env,b).catch(() => null)
  if (message?.kind==='template') return templateDisplayText(env,b.workspace_id,b.channel_id,message)
  const name=(await env.DB.prepare('SELECT name_human FROM message_templates WHERE workspace_id=? AND id=?')
    .bind(b.workspace_id,JSON.parse(b.template!).id).first<{name_human:string}>())?.name_human ?? 'modelo'
  return `[Modelo: ${name}]`
}
async function linkMessages(env: Env,b: Stored,r: Recipient) {
  const parts = await env.DB.prepare('SELECT step_index,part,status,external_message_id FROM flow_outbound WHERE run_id=?').bind(r.run_id)
    .all<{step_index:number;part:number;status:string;external_message_id:string|number|null}>()
  for (const p of parts.results) {
    const messageId = `out-${await stableId(r.run_id,String(p.step_index),String(p.part))}`
    if (p.status==='sent' && p.external_message_id!==null) {
      const externalId = `${b.channel_type}:${b.channel_id}:${r.external_user_id}:${p.external_message_id}`
      const conversationId = await ensureConversation(env,b.workspace_id,r.contact_id,b.channel_id)
      await recordMessage(env,{id:messageId,workspaceId:b.workspace_id,conversationId,direction:'out',sender:'automation',
        text:b.template ? await broadcastTemplateText(env,b) : r.resolved_content ?? b.content,
        status:'sent',externalMessageId:externalId})
      // A confirmed durable send can survive a crash before inbox insertion. Preserve later provider receipts.
      await env.DB.prepare(`UPDATE messages SET content=CASE WHEN external_message_id IS NULL THEN json_set(content,'$.status','sent') ELSE content END,
        external_message_id=coalesce(external_message_id,?) WHERE workspace_id=? AND id=?`)
        .bind(externalId,b.workspace_id,messageId).run()
    }
    await env.DB.prepare(`UPDATE messages SET source='broadcast',content=json_set(content,'$.broadcast',json(?)) WHERE workspace_id=? AND id=?`)
      .bind(JSON.stringify({id:b.id,recipient:r.contact_channel_id}),b.workspace_id,messageId).run()
  }
}
async function firstGraphMessages(env: Env,b: Stored,r: Recipient,runId: string|null):Promise<OutboundMessage[]> {
  const graph=validateGraph(JSON.parse(b.copied_graph!)),node=graph.nodes.find(n=>n.id===b.first_node_id)!
  const config=messageSchema.parse(node.config),render=await contactVariableRenderer(env.DB,b.workspace_id,r.contact_id)
  const timeout=milliseconds(config.click_timeout ?? {value:23,unit:'hours'})
  const buttons=[] as NonNullable<Extract<OutboundMessage,{kind:'text'}>['buttons']>
  for (const button of config.blocks.filter(block=>block.kind==='button')) {
    if (button.action.type==='url') {
      const target=render(button.action.url)
      const url=runId ? await broadcastLink(env,{workspace:b.workspace_id,broadcast:b.id,contactChannel:r.contact_channel_id},{id:button.id,url:target}) : target
      buttons.push({type:'url',title:render(button.label),url});continue
    }
    let token='0'.repeat(24)
    if (runId) {
      token=Array.from(crypto.getRandomValues(new Uint8Array(12)),b=>b.toString(16).padStart(2,'0')).join('')
      await env.DB.prepare('INSERT INTO button_tokens(token,workspace_id,run_id,node_id,step_index,button_id,expires_at) VALUES (?,?,?,?,0,?,?) ON CONFLICT(run_id,step_index,button_id) DO NOTHING')
        .bind(token,b.workspace_id,runId,node.id,button.id,Date.now()+timeout).run()
      token=(await env.DB.prepare('SELECT token FROM button_tokens WHERE run_id=? AND step_index=0 AND button_id=?').bind(runId,button.id).first<{token:string}>())!.token
    }
    buttons.push({type:'postback',title:render(button.label),id:`b:${token}`})
  }
  const wanted=config.blocks.filter(block=>block.kind==='text' || block.kind==='media' || isCards(block))
  const profile=wanted.some(block=>block.kind==='media' || isCards(block)) ? await profileOf(env,b.workspace_id,b.channel_id) : null
  const sendable=profile ? mergeLeadText(wanted,profile) : wanted
  if (buttons.length && sendable.at(-1)?.kind==='media') sendable.push({kind:'text',text:'Escolha uma opção:'})
  return Promise.all(sendable.map(async (block,index):Promise<OutboundMessage>=>{
    if (block.kind==='text') return {kind:'text',text:render(block.text),...(index===sendable.length-1 && buttons.length?{buttons}:{})}
    if (isCards(block)) return cardsMessage({...block,...(block as LeadCardsBlock).text?{text:render((block as LeadCardsBlock).text!)}:{},cards:block.cards.map(c=>({...c,title:render(c.title),subtitle:c.subtitle?render(c.subtitle):undefined,imageUrl:c.imageUrl?render(c.imageUrl):undefined,actionUrl:c.actionUrl?render(c.actionUrl):undefined,
      buttons:c.buttons?.map(button=>({...button,title:render(button.title),...(button.type==='url'?{url:render(button.url)}:button.type==='postback'?{id:render(button.id)}:{phone:render(button.phone)})}))}))})
    const media=await storedMedia(env,b.workspace_id,{...block,url:render(block.url)}),error=mediaError(media,[profile!],false)
    if (error) throw conflict(error)
    return {kind:'media',media:media.media,url:media.url,size:media.size,mime:media.mime}
  }))
}
async function startBroadcastContinuation(env: Env,b: Stored,r: Recipient) {
  if (!env.FLOW_RUN) throw new HTTPException(503,{message:'O executor de automações não está configurado.'})
  // Só a execução que segue em running continua: o contato que saiu (ou foi apagado) no meio do envio deixou ela cancelled, e ela fica assim.
  await env.DB.prepare(`UPDATE flow_runs SET start_node_id=?,current_node_id=? WHERE workspace_id=? AND id=? AND workflow_created_at IS NULL AND ${runGuard('running','status',['running'])}`)
    .bind(b.first_node_id,b.first_node_id,b.workspace_id,r.run_id).run()
  await ensureWorkflow(env as FlowEnv,r.run_id)
}
/** Processes at most five recipients. Queue redeliveries share a lease and adapter's durable send claim. */
export async function processBroadcastBatch(env: Env, workspaceId: string, broadcastId: string, factory?: (type: string, env: Awaited<ReturnType<typeof adapterEnvFor>>) => ChannelAdapter): Promise<{delaySeconds?:number}> {
  let b: Stored
  try { b = await stored(env,workspaceId,broadcastId) } catch(error) { if (error instanceof HTTPException && error.status===404) return {}; throw error }
  if (!['scheduled','sending'].includes(b.status) || b.paused_at !== null) return {}
  if (b.scheduled_at !== null && b.scheduled_at>Date.now()) return {delaySeconds:Math.min(43200,Math.ceil((b.scheduled_at-Date.now())/1000))}
  const token = crypto.randomUUID(), now = Date.now()
  const claim = await env.DB.prepare(`UPDATE broadcasts SET lease_token=?,lease_until=? WHERE workspace_id=? AND id=?
    AND status IN ('scheduled','sending') AND paused_at IS NULL AND (lease_until IS NULL OR lease_until<=?) RETURNING id`)
    .bind(token,now+120000,workspaceId,broadcastId,now).first()
  if (!claim) return {delaySeconds:120}
  try {
    // A draft edit or cancellation may have committed between the first read and this lease.
    b=await stored(env,workspaceId,broadcastId)
    if (b.scheduled_at!==null && b.scheduled_at>Date.now()) return {delaySeconds:Math.min(43200,Math.ceil((b.scheduled_at-Date.now())/1000))}
    try { await assertChannel(env,workspaceId,b.channel_id); assertWindowKind(b.window_kind,await profileOf(env,workspaceId,b.channel_id),!!b.template); await messageFor(env,b); if (b.copied_graph && !env.FLOW_RUN) throw new Error('Workflow unavailable') }
    catch { await env.DB.prepare(`UPDATE broadcasts SET paused_at=?,pause_reason='channel_or_template_unavailable' WHERE workspace_id=? AND id=? AND lease_token=?`)
      .bind(Date.now(),workspaceId,broadcastId,token).run(); return {} }
    if (b.started_at === null) {
      await snapshot(env,b,token); b = await stored(env,workspaceId,broadcastId)
      // Retrato recusado (o lease venceu e a transmissão foi cancelada ou é de outra rodada): nada a enviar nesta.
      if (b.started_at === null || b.status !== 'sending') return {}
    }
    const adapter = factory ? factory(b.channel_type,await adapterEnvFor(env,workspaceId,b.channel_id,b.channel_type as ChannelType)) : await connectionAdapter(env,workspaceId,b.channel_id,b.channel_type), profile = await profileOf(env,workspaceId,b.channel_id)
    const rows = await env.DB.prepare(`SELECT recipients.*,r.run_id,r.status,r.resolved_content FROM (${recipientSelection}) recipients JOIN broadcast_recipients r
      ON r.contact_channel_id=recipients.contact_channel_id WHERE r.workspace_id=? AND r.broadcast_id=? AND r.status IN ('queued','sending')
      ORDER BY recipients.contact_channel_id LIMIT 5`).bind(workspaceId,broadcastId).all<Recipient>()
    for (const r of rows.results) {
      b = await stored(env,workspaceId,broadcastId)
      if (b.paused_at !== null) return {}
      let message: OutboundMessage
      try { await assertChannel(env,workspaceId,b.channel_id); message=await messageFor(env,{ ...b, content: await recipientContent(env,b,r) }) }
      catch { await env.DB.prepare(`UPDATE broadcasts SET paused_at=?,pause_reason='channel_or_template_unavailable' WHERE workspace_id=? AND id=?`)
        .bind(Date.now(),workspaceId,broadcastId).run(); return {} }
      await env.DB.prepare('UPDATE broadcasts SET lease_until=? WHERE workspace_id=? AND id=? AND lease_token=?')
        .bind(Date.now()+120000,workspaceId,broadcastId,token).run()
      const initialMessages = b.copied_graph ? await firstGraphMessages(env,b,r,null) : [message]
      const expectedParts = initialMessages.reduce((count,item) => {
        const fit = adapter.fit(item,profile)
        return count < 0 || 'ok' in fit ? -1 : count + fit.messages.length
      },0)
      const confirmed = await env.DB.prepare("SELECT count(*) AS n FROM flow_outbound WHERE run_id=? AND step_index=0 AND status='sent'").bind(r.run_id).first<{n:number}>()
      if (expectedParts > 0 && confirmed?.n === expectedParts) {
        await linkMessages(env,b,r)
        if (b.copied_graph) await startBroadcastContinuation(env,b,r)
        await markRecipient(env,b,r,'sent',null,b.copied_graph ? undefined : 'done')
        continue
      }
      // Refresh consent/window just before this recipient, including changes made since the snapshot.
      const fresh = await env.DB.prepare(`${recipientSelection} WHERE cc.workspace_id=? AND cc.id=?`).bind(workspaceId,r.contact_channel_id).first<Recipient>()
      if (!fresh) continue
      Object.assign(r,fresh)
      const mode = permission(adapter,fresh,Date.now())
      // Whoever asked the provider to stop receiving marketing is skipped, not a failure, but only for a marketing model.
      if (fresh.marketing_blocked_at && isMarketing(message)) { await markRecipient(env,b,r,'skipped','marketing_opt_out'); continue }
      if (fresh.broadcast_opt_in === 0) { await markRecipient(env,b,r,'skipped','do_not_send'); continue }
      if (!allowed(mode,message,profile)) { await markRecipient(env,b,r,'skipped',mode.ok ? null : mode.reason); continue }
      const run: Run = { id:r.run_id,workspace_id:workspaceId,contact_id:r.contact_id,channel_id:b.channel_id,channel_type:b.channel_type,
        automation_id:b.automation_id!,automation_version_id:`broadcast-version-${b.id}`,graph:b.copied_graph ?? '{}',start_node_id:b.first_node_id ?? broadcastStepId,depth:0,external_user_id:r.external_user_id }
      await env.DB.prepare(`INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id,current_node_id) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
        .bind(run.id,workspaceId,run.contact_id,run.automation_version_id,run.channel_id,run.start_node_id).run()
      await markRecipient(env,b,r,'sending')
      let result: SendResult
      try {
        const messages=b.copied_graph ? await firstGraphMessages(env,b,r,run.id) : [message]
        let part=0
        result={ok:true,externalId:'',parts:0}
        for (const item of messages) {
          const fit=adapter.fit(item,profile)
          if ('ok' in fit) {result=fit;break}
          for (const fitted of fit.messages) {
            result=await adapter.send({run,runId:run.id,step:0,part:part++,channelId:b.channel_id,externalUserId:r.external_user_id,mode},fitted)
            if (!result.ok) break
          }
          if (!result.ok) break
        }
      }
      catch { result={ok:false,reason:'uncertain',detail:'Envio sem confirmação.'} }
      await linkMessages(env,b,r)
      if (!result.ok) {
        const durable = await env.DB.prepare(`SELECT count(*) AS total,sum(status='sent') AS sent,max(external_message_id) AS external_id
          FROM flow_outbound WHERE run_id=? AND step_index=0`).bind(r.run_id).first<{total:number;sent:number;external_id:string|null}>()
        if (durable?.total && durable.total===expectedParts && durable.total===durable.sent) result={ok:true,externalId:String(durable.external_id),parts:durable.total}
      }
      if (!result.ok) await noteConnectionFailure(env,workspaceId,b.channel_id,result)
      if (!result.ok && (result.reason==='rate_limited' || result.reason==='rejected' && failureAction(result.code)==='pause')) {
        if (result.reason==='rejected') {
          // Explicit provider rejection proves no acceptance. Only these known rejections may retry.
          await env.DB.prepare("UPDATE flow_outbound SET status='ready' WHERE run_id=? AND status='uncertain'").bind(r.run_id).run()
        }
        await markRecipient(env,b,r,'queued',result.reason==='rejected' ? result.code : result.reason)
        await env.DB.prepare(`UPDATE broadcasts SET paused_at=?,pause_reason=?,retry_at=? WHERE workspace_id=? AND id=?`)
          .bind(Date.now(),result.reason==='rejected' ? result.code : result.reason,
            result.reason==='rate_limited' ? Date.now()+result.retryAfterSec*1000 : null,workspaceId,broadcastId).run()
        return {}
      }
      // A contact-level refusal is kept with its code; a contact Meta will not reach with marketing is skipped, not a failure.
      const outcome = result.ok ? { status: 'sent' as const, reason: null } : recipientFailure(result,b.channel_type)
      if (result.ok && b.copied_graph) await startBroadcastContinuation(env,b,r)
      await markRecipient(env,b,r,outcome.status,outcome.reason,!result.ok ? 'failed' : b.copied_graph ? undefined : 'done')
    }
    const pending = await env.DB.prepare(`SELECT 1 AS n FROM broadcast_recipients WHERE workspace_id=? AND broadcast_id=? AND status IN ('queued','sending') LIMIT 1`)
      .bind(workspaceId,broadcastId).first()
    if (pending) return {delaySeconds:1}
    // Só uma transmissão ainda em envio vira enviada: um estado final gravado por outro escritor fica.
    await env.DB.prepare(`UPDATE broadcasts SET status='sent',sent_count=(SELECT count(*) FROM broadcast_recipients WHERE broadcast_id=? AND status='sent') WHERE workspace_id=? AND id=? AND status='sending'`)
      .bind(broadcastId,workspaceId,broadcastId).run()
    return {}
  } finally {
    await env.DB.prepare('UPDATE broadcasts SET lease_token=NULL,lease_until=NULL WHERE workspace_id=? AND id=? AND lease_token=?').bind(workspaceId,broadcastId,token).run()
  }
}
export const broadcastQueueMessage = z.object({kind:z.literal('broadcast'),workspaceId:id,broadcastId:id}).strict()
export async function consumeBroadcast(message: Message<unknown>, env: Env) {
  const parsed = broadcastQueueMessage.safeParse(message.body)
  if (!parsed.success) { message.ack(); return }
  try {
    const result=await processBroadcastBatch(env,parsed.data.workspaceId,parsed.data.broadcastId)
    if (result.delaySeconds !== undefined) await enqueueBroadcast(env,parsed.data.workspaceId,parsed.data.broadcastId,result.delaySeconds)
    message.ack()
  } catch { message.retry({delaySeconds:60}) }
}
