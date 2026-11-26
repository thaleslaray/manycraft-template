import { contactVariableRenderer } from '../db/message-variables'
import { inboxTeam, inboxMembers } from './team'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from '../env'
import type { AuthVariables } from '../team'
import { boundedBody } from '../security'
import { bucketOf, mediaPublicBase } from '../media-blocks'
import { mediaKinds } from '../schemas/message-media'
import { authorize } from '../permissions'
import { connectionRuntime } from '../channels/core/runtime'
import { deliverHuman, type HumanMedia } from '../channels/core/delivery'
import { startConversation, startSchema } from '../channels/core/start-conversation'
import { assertConversation, ensureConversation, getConversation, listConversations, listMessages, notifyConversation, recordMessage } from './service'
import { ensureWorkflow, hasFlow } from '../flow/dispatch'
import { activeRunStatusSql } from '../flow/run-status'
import { inboxLabels } from './labels'
import { drainMemberAlerts, queueAssignedAlert } from '../team-alerts'

export const inbox = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const identifier = z.string().min(1).max(256)
export const inboxConversationListQuerySchema = z.object({ status: z.enum(['open', 'closed', 'all']).default('open'), cursor: z.string().max(1024).optional(), contact_filter: z.string().max(16384).optional() })
export const inboxMessageListQuerySchema = z.object({ before: z.string().max(1024).optional() })
export const inboxScheduledSchema = z.object({ text: z.string().trim().min(1).max(4096), send_at: z.iso.datetime({ offset: true }) }).strict()
export const inboxMessageSchema = z.union([
  z.object({ text: z.string().trim().min(1).max(4096), kind: z.enum(['reply', 'note']), mention_member_ids: z.array(identifier).max(30).optional() }).strict(),
  z.object({ kind: z.literal('media'), media: z.enum(mediaKinds), media_id: z.string().regex(/^[a-f0-9-]{36}$/), caption: z.string().trim().min(1).max(1024).optional(), name: z.string().trim().min(1).max(255).optional() }).strict(),
  z.object({ kind: z.literal('template'), template: z.object({ id: identifier, params: z.record(z.string().max(128), z.string().trim().min(1).max(1024)) }).strict() }).strict(),
])
export const inboxRunAutomationSchema = z.object({ automation_id: identifier }).strict()
export const inboxReminderSchema = z.object({ at: z.iso.datetime({ offset: true }).nullable(), note: z.string().trim().max(500).optional() }).strict()
export const inboxStatusSchema = z.object({ status: z.enum(['open', 'closed']) }).strict()
export const inboxAssignSchema = z.object({ member_id: identifier.nullable() }).strict()
function cursor(value?: string): [number, string] | undefined {
  if (!value) return undefined
  try { return z.tuple([z.number().int().nonnegative(), identifier]).parse(JSON.parse(atob(value))) }
  catch { throw new HTTPException(400, { message: 'Paginação inválida.' }) }
}
async function json(request: Request) {
  await boundedBody(request.clone(), 64 * 1024)
  try { return await request.json() } catch { throw new HTTPException(400, { message: 'JSON inválido.' }) }
}
inbox.use('*', async (c, next) => {
  if (c.req.method !== 'GET') authorize(c.var.principal, 'inbox:reply')
  await next()
})
inbox.route('/', inboxTeam)
inbox.route('/', inboxLabels)
inbox.get('/live', async c => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') throw new HTTPException(426)
  const origin = c.req.header('origin')
  if (origin && origin !== new URL(c.env.BETTER_AUTH_URL ?? c.req.url).origin && origin !== new URL(c.req.url).origin) throw new HTTPException(403)
  if (!c.env.INBOX_HUB) throw new HTTPException(503, { message: 'Tempo real indisponível.' })
  // O dono da conexão é o usuário autenticado: o cabeçalho é sobrescrito, nunca repassado do cliente.
  const headers = new Headers(c.req.raw.headers)
  headers.set('x-inbox-user', c.var.principal.userId)
  headers.delete('x-inbox-session')
  if (c.var.sessionId) headers.set('x-inbox-session', c.var.sessionId)
  return c.env.INBOX_HUB.get(c.env.INBOX_HUB.idFromName(c.var.principal.workspaceId)).fetch(new Request(c.req.raw, { headers }))
})
inbox.get('/conversations', async c => {
  const q = inboxConversationListQuerySchema.parse(c.req.query())
  let filter: unknown
  if (q.contact_filter !== undefined) { try { filter = JSON.parse(q.contact_filter) } catch { throw new HTTPException(400, { message: 'Filtro inválido.' }) } }
  return c.json(await listConversations(c.env, c.var.principal.workspaceId, q.status, cursor(q.cursor), filter))
})
/** Starts a conversation with a number that never wrote: an approved template to a phone, after the operator confirms consent. */
inbox.post('/conversations', async c => {
  authorize(c.var.principal, 'edit')
  const body = startSchema.parse(await json(c.req.raw))
  return c.json(await startConversation(c.env, c.var.principal.workspaceId, body), 201)
})
/** Files the contact sent. Only members of the workspace that owns the file read it; it never gets a public address. Types a browser can show
 * (photo, audio, video) open in place, everything else downloads, and nothing is ever interpreted as a page. */
const inlineTypes = /^(?:image\/(?:jpeg|png|webp|gif)|audio\/[a-z0-9.+-]+|video\/(?:mp4|3gpp|webm|quicktime|ogg))$/
inbox.get('/media/:id', async c => {
  const id = z.string().regex(/^[a-f0-9-]{36}$/).parse(c.req.param('id'))
  const row = await c.env.DB.prepare('SELECT object_key,content_type,size,bucket FROM media_objects WHERE workspace_id=? AND id=?').bind(c.var.principal.workspaceId, id)
    .first<{ object_key: string; content_type: string; size: number; bucket: string }>()
  const store = row && bucketOf(c.env, row.bucket)
  if (!row || !store) throw new HTTPException(404)
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '')
  let start = 0, end = row.size - 1
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, row.size - Number(range[2]))
    end = range[1] && range[2] ? Math.min(Number(range[2]), row.size - 1) : row.size - 1
    if (start > end || start >= row.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${row.size}` } })
  }
  const partial = start !== 0 || end !== row.size - 1
  const object = await store.get(row.object_key, partial ? { range: { offset: start, length: end - start + 1 } } : undefined)
  if (!object) throw new HTTPException(404)
  return new Response(object.body, { status: partial ? 206 : 200, headers: {
    'Content-Type': row.content_type, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes',
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${row.size}` } : {}),
    'Content-Disposition': inlineTypes.test(row.content_type) ? 'inline' : 'attachment', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store' } })
})
inbox.get('/conversations/:id/messages', async c => {
  const q = inboxMessageListQuerySchema.parse(c.req.query())
  return c.json(await listMessages(c.env, c.var.principal.workspaceId, identifier.parse(c.req.param('id')), cursor(q.before)))
})
/** POST /inbox/conversations/:id/resume-automations: corpo vazio ou `{}`. */
export const inboxResumeAutomationsSchema = z.object({}).strict()
inbox.post('/conversations/:id/resume-automations', async c => {
  authorize(c.var.principal, 'edit')
  const raw = await c.req.text()
  if (raw.trim()) {
    let body: unknown
    try { body = JSON.parse(raw) } catch { throw new HTTPException(400, { message: 'JSON inválido.' }) }
    inboxResumeAutomationsSchema.parse(body)
  }
  const workspaceId = c.var.principal.workspaceId, id = identifier.parse(c.req.param('id'))
  const conversation = await getConversation(c.env, workspaceId, id)
  await c.env.DB.prepare('UPDATE contacts SET automation_paused_until=NULL WHERE workspace_id=? AND id=?')
    .bind(workspaceId, conversation.contact.id).run()
  const runs = await c.env.DB.prepare(`SELECT id FROM flow_runs WHERE workspace_id=? AND contact_id=?
    AND status IN (${activeRunStatusSql}) AND workflow_created_at IS NOT NULL`)
    .bind(workspaceId, conversation.contact.id).all<{ id: string }>()
  const results = await Promise.allSettled(runs.results.map(async run => {
    if (c.env.FLOW_RUN) await (await c.env.FLOW_RUN.get(run.id)).sendEvent({ type: 'automation_resume', payload: {} })
  }))
  await notifyConversation(c.env, workspaceId, id)
  // Retry remains safe even after the flag was cleared; repeat requests re-signal all waiting runs.
  if (results.some(result => result.status === 'rejected')) throw new HTTPException(503, { message: 'A pausa foi removida, mas um fluxo ainda não recebeu o aviso. Tente de novo.' })
  return c.json(await getConversation(c.env, workspaceId, id))
})
/** Resposta humana por uma conversa: conexão atual do contato, mesmas regras de janela e opt-in. Usada pelo composer e pela mensagem agendada. */
async function sendHumanReply(env: Env, workspaceId: string, conversationId: string, contactId: string, content: { text: string; template?: { id: string; params: Record<string, string> }; media?: HumanMedia }) {
  const target = await env.DB.prepare(`SELECT cc.external_user_id,cc.channel_id FROM conversations v
    JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
    WHERE v.workspace_id=? AND v.id=?`).bind(workspaceId, conversationId).first<{ external_user_id: string; channel_id: string }>()
  const rt = target ? await connectionRuntime(env, workspaceId, target.channel_id, { requireConnected: true }).catch(() => undefined) : undefined
  // Mesmo renderizador do motor das automações: {{primeiro_nome|reserva}}, campos e afins saem trocados pelos dados do contato.
  const text = content.text ? (await contactVariableRenderer(env.DB, workspaceId, contactId))(content.text) : content.text
  return deliverHuman(env, rt?.provider ? { connection: rt.connection, provider: rt.provider, credentials: rt.credentials } : undefined, {
    workspaceId, conversationId, contactId, externalUserId: target?.external_user_id ?? '', text, ...(content.template ? { template: content.template } : {}), ...(content.media ? { media: content.media } : {}) })
}
function sendRefusal(reason: string): string {
  if (reason === 'rate_limited') return 'Aguarde um instante antes de enviar novamente.'
  if (reason === 'outside_window') return 'A janela de atendimento deste contato terminou (24 h desde a última mensagem dele): responda com um modelo aprovado.'
  if (reason === 'not_opted_in') return 'O contato não autorizou receber modelos por este canal.'
  return 'Este canal ainda não está disponível para envio.'
}
/** The file the operator picked, read from this workspace's own uploads (POST /api/media); the link providers fetch is rebuilt here, never trusted from the client. */
async function attachedMedia(env: Env, workspaceId: string, body: { media: HumanMedia['media']; media_id: string; caption?: string; name?: string }): Promise<HumanMedia> {
  const row = await env.DB.prepare('SELECT object_key,content_type,size,bucket FROM media_objects WHERE workspace_id=? AND id=?').bind(workspaceId, body.media_id)
    .first<{ object_key: string; content_type: string; size: number; bucket: string }>()
  if (!row) throw new HTTPException(409, { message: 'O anexo não está disponível neste espaço.' })
  // O que o contato mandou fica no bucket privado: nunca ganha endereço público, nem para reenviar.
  if (row.bucket === 'inbound') throw new HTTPException(409, { message: 'Arquivos que o contato enviou não podem ser reenviados como anexo.' })
  const base = mediaPublicBase(env)
  if (!base) throw new HTTPException(503, { message: 'Armazenamento não configurado.' })
  return { id: body.media_id, media: body.media, url: `${base}/${row.object_key}`, mime: row.content_type, size: row.size,
    ...(body.name ? { name: body.name } : {}), ...(body.caption ? { caption: body.caption } : {}) }
}

/** Mensagens agendadas da conversa (as que ainda vão sair e as últimas que saíram ou falharam). */
inbox.get('/conversations/:id/scheduled', async c => {
  const workspaceId = c.var.principal.workspaceId, id = identifier.parse(c.req.param('id'))
  // A conversa (404 se não existe) e as mensagens agendadas saem na mesma onda.
  const [, rows] = await Promise.all([assertConversation(c.env, workspaceId, id), c.env.DB.prepare(`SELECT s.id,s.text,s.send_at,s.status,s.error,s.created_by,coalesce(nullif(u.name,''),u.email) AS created_by_name FROM inbox_scheduled_messages s LEFT JOIN "user" u ON u.id=s.created_by
    WHERE s.workspace_id=? AND s.conversation_id=? AND s.status<>'cancelled' ORDER BY s.send_at DESC LIMIT 20`).bind(workspaceId, id)
    .all<{ id: string; text: string; send_at: number; status: string; error: string | null; created_by: string; created_by_name: string | null }>()])
  return c.json(rows.results.map(r => ({ ...r, send_at: new Date(r.send_at).toISOString(), mine: r.created_by === c.var.principal.userId })))
})
inbox.post('/conversations/:id/scheduled', async c => {
  const workspaceId = c.var.principal.workspaceId, id = identifier.parse(c.req.param('id'))
  await getConversation(c.env, workspaceId, id)
  const body = inboxScheduledSchema.parse(await json(c.req.raw))
  const at = Date.parse(body.send_at)
  if (at <= Date.now() + 30_000 || at > Date.now() + 30 * 86400_000) throw new HTTPException(400, { message: 'Agende para daqui a pelo menos 1 minuto e em até 30 dias.' })
  const scheduledId = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO inbox_scheduled_messages (id,workspace_id,conversation_id,text,send_at,created_by) VALUES (?,?,?,?,?,?)')
    .bind(scheduledId, workspaceId, id, body.text, at, c.var.principal.userId).run()
  return c.json({ id: scheduledId }, 201)
})
inbox.delete('/conversations/:id/scheduled/:scheduledId', async c => {
  const workspaceId = c.var.principal.workspaceId, scheduledId = identifier.parse(c.req.param('scheduledId'))
  const row = await c.env.DB.prepare("SELECT created_by FROM inbox_scheduled_messages WHERE workspace_id=? AND id=? AND status='scheduled'").bind(workspaceId, scheduledId).first<{ created_by: string }>()
  if (!row) throw new HTTPException(404, { message: 'Agendamento não encontrado ou já enviado.' })
  if (row.created_by !== c.var.principal.userId && !['owner', 'administrator'].includes(c.var.principal.role)) throw new HTTPException(403, { message: 'Só quem agendou ou um administrador cancela.' })
  await c.env.DB.prepare("UPDATE inbox_scheduled_messages SET status='cancelled' WHERE workspace_id=? AND id=? AND status='scheduled'").bind(workspaceId, scheduledId).run()
  return c.body(null, 204)
})

/** Uma rodada do cron dura no máximo 15 minutos: em "enviando" há mais que isso, a rodada que pegou a mensagem morreu no meio. */
const scheduledSendingLimit = 15 * 60_000
const scheduledUnconfirmed = 'Envio sem confirmação; verifique antes de reenviar.'
function recordScheduledFailure(env: Env, row: { id: string; workspace_id: string; conversation_id: string }, error: string) {
  return recordMessage(env, { id: `scheduled-failed-${row.id}`, workspaceId: row.workspace_id, conversationId: row.conversation_id, direction: 'out', sender: 'system',
    text: `Mensagem agendada não saiu: ${error}` }).catch(() => {})
}

/** Envia as mensagens agendadas vencidas. Na hora vale a regra do canal: janela fechada ou opt-out viram falha registrada na conversa. */
export async function sendDueScheduledMessages(env: Env, now = Date.now()) {
  // Presa em "enviando" (a rodada morreu entre pegar e gravar o resultado): vira falha avisada na conversa e nunca é reenviada
  // sozinha, como a resposta humana. send_at é a hora em que a rodada a pegou (gravada abaixo).
  const stuck = await env.DB.prepare("UPDATE inbox_scheduled_messages SET status='failed',error=? WHERE status='sending' AND send_at<=? RETURNING id,workspace_id,conversation_id")
    .bind(scheduledUnconfirmed, now - scheduledSendingLimit).all<{ id: string; workspace_id: string; conversation_id: string }>()
  for (const row of stuck.results) await recordScheduledFailure(env, row, scheduledUnconfirmed)
  const due = await env.DB.prepare("SELECT id,workspace_id,conversation_id,text FROM inbox_scheduled_messages WHERE status='scheduled' AND send_at<=? ORDER BY send_at LIMIT 50")
    .bind(now).all<{ id: string; workspace_id: string; conversation_id: string; text: string }>()
  for (const row of due.results) {
    // Pegar grava a hora desta rodada em send_at: uma agendada atrasada que acabou de ser pega não parece presa para a rodada seguinte.
    if (!await env.DB.prepare("UPDATE inbox_scheduled_messages SET status='sending',send_at=? WHERE id=? AND status='scheduled' RETURNING id").bind(now, row.id).first()) continue
    let error: string | null = null
    try {
      const conversation = await getConversation(env, row.workspace_id, row.conversation_id)
      const sent = await sendHumanReply(env, row.workspace_id, row.conversation_id, conversation.contact.id, { text: row.text })
      // Limite de envio do canal: tenta de novo no próximo minuto em vez de falhar.
      if (!sent.ok && sent.reason === 'rate_limited') {
        await env.DB.prepare("UPDATE inbox_scheduled_messages SET status='scheduled',send_at=? WHERE id=? AND status='sending'").bind(now + Math.max(60, sent.retryAfter ?? 60) * 1000, row.id).run()
        continue
      }
      if (!sent.ok) error = sendRefusal(sent.reason)
      // A resposta humana volta ok:true com a mensagem gravada como falha quando o canal recusa ou a rede cai: a agendada segue a conversa.
      else if (sent.message.status === 'failed') error = sent.message.error ?? scheduledUnconfirmed
    } catch { error = 'A conversa ou a conexão não está mais disponível.' }
    // Só sai de "enviando": um estado final que outro escritor já gravou fica.
    const closed = await env.DB.prepare("UPDATE inbox_scheduled_messages SET status=?,error=? WHERE id=? AND status='sending' RETURNING id").bind(error ? 'failed' : 'sent', error, row.id).first()
    if (closed && error) await recordScheduledFailure(env, row, error)
  }
  return due.results.length
}

inbox.post('/conversations/:id/messages', async c => {
  const body = inboxMessageSchema.parse(await json(c.req.raw))
  const workspaceId = c.var.principal.workspaceId, id = identifier.parse(c.req.param('id'))
  const conversation = await getConversation(c.env, workspaceId, id)
  const eligible = await inboxMembers(c.env, workspaceId)
  const mentions = [...new Set('mention_member_ids' in body ? body.mention_member_ids ?? [] : [])]
  if (mentions.length && (body.kind !== 'note' || mentions.some(id => !eligible.some(m => m.id === id)))) throw new HTTPException(400, { message: 'Mencione uma pessoa com acesso à caixa de entrada.' })
  if (body.kind === 'note') return c.json(await recordMessage(c.env, {
    workspaceId, conversationId: id, direction: 'out', sender: 'note', text: body.text, mentionMemberIds: mentions,
  }), 201)
  if (conversation.status === 'closed') throw new HTTPException(409, { message: 'Reabra a conversa antes de responder.' })
  const sent = await sendHumanReply(c.env, workspaceId, id, conversation.contact.id,
    body.kind === 'template' ? { text: '', template: body.template } : body.kind === 'media' ? { text: '', media: await attachedMedia(c.env, workspaceId, body) } : { text: body.text })
  if (!sent.ok && sent.reason === 'rate_limited') { c.header('Retry-After', String(sent.retryAfter)); throw new HTTPException(429, { message: 'Aguarde um instante antes de enviar novamente.' }) }
  if (!sent.ok) throw new HTTPException(409, { message: sent.reason === 'unsupported' ? `Este canal não aceita esse anexo: ${sent.detail}` : sendRefusal(sent.reason) })
  return c.json(sent.message, 201)
})
/** Abrir conversa a partir do perfil: usa a conexão por onde o contato falou por último (ou a mais antiga) e cria a conversa se ainda não houver. */
inbox.post('/contacts/:contactId/conversation', async c => {
  const workspaceId = c.var.principal.workspaceId, contactId = identifier.parse(c.req.param('contactId'))
  const link = await c.env.DB.prepare(`SELECT cc.channel_id FROM contact_channels cc JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id AND ch.archived_at IS NULL
    JOIN contacts ct ON ct.workspace_id=cc.workspace_id AND ct.id=cc.contact_id AND ct.status<>'deleted'
    WHERE cc.workspace_id=? AND cc.contact_id=? ORDER BY coalesce(cc.last_inbound_at,0) DESC,cc.created_at LIMIT 1`).bind(workspaceId, contactId).first<{ channel_id: string }>()
  if (!link) throw new HTTPException(409, { message: 'Este contato ainda não tem conexão para conversar. Inicie pelo botão Nova conversa da Caixa de entrada.' })
  const id = await ensureConversation(c.env, workspaceId, contactId, link.channel_id)
  return c.json({ id })
})
/** Automações ligadas que a equipe pode rodar pelo chat (só nome; o atendente não lê as automações em si). */
inbox.get('/runnable-automations', async c => {
  const workspaceId = c.var.principal.workspaceId
  const conversationId = c.req.query('conversation_id')
  // Com a conversa informada, só entram as automações cujos gatilhos usam o canal dela (ou que não prendem nenhum canal).
  // O canal da conversa vem por subconsulta (uma ida só); conversa que não existe não filtra nada, como antes.
  const channelOf = `(SELECT ch.type FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
    JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id WHERE v.workspace_id=? AND v.id=?)`
  const rows = await c.env.DB.prepare(`SELECT a.id,a.name FROM automations a WHERE a.workspace_id=? AND a.status='live' AND a.deleted_at IS NULL AND a.published_version_id IS NOT NULL
    ${conversationId ? `AND (${channelOf} IS NULL OR NOT EXISTS (SELECT 1 FROM triggers t WHERE t.workspace_id=a.workspace_id AND t.automation_id=a.id AND t.channel_id IS NOT NULL)
      OR EXISTS (SELECT 1 FROM triggers t JOIN channels ch ON ch.workspace_id=t.workspace_id AND ch.id=t.channel_id WHERE t.workspace_id=a.workspace_id AND t.automation_id=a.id AND ch.type=${channelOf}))` : ''}
    ORDER BY a.name,a.id LIMIT 200`).bind(...(conversationId ? [workspaceId, workspaceId, identifier.parse(conversationId), workspaceId, identifier.parse(conversationId)] : [workspaceId])).all<{ id: string; name: string }>()
  return c.json(rows.results)
})
/** Rodar uma automação publicada para o contato desta conversa, pela conexão da conversa. */
inbox.post('/conversations/:id/run-automation', async c => {
  const workspaceId = c.var.principal.workspaceId, id = identifier.parse(c.req.param('id'))
  await getConversation(c.env, workspaceId, id)
  const { automation_id } = inboxRunAutomationSchema.parse(await json(c.req.raw))
  if (!hasFlow(c.env)) throw new HTTPException(503, { message: 'O executor de automações não está disponível.' })
  const link = (await c.env.DB.prepare(`SELECT cc.contact_id,cc.channel_id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
    WHERE v.workspace_id=? AND v.id=?`).bind(workspaceId, id).first<{ contact_id: string; channel_id: string }>())!
  const runId = `inbox-${crypto.randomUUID()}`
  const created = await c.env.DB.prepare(`INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id)
    SELECT ?,?,?,a.published_version_id,? FROM automations a WHERE a.workspace_id=? AND a.id=? AND a.status='live' AND a.deleted_at IS NULL AND a.published_version_id IS NOT NULL`)
    .bind(runId, workspaceId, link.contact_id, link.channel_id, workspaceId, automation_id).run()
  if (!created.meta.changes) throw new HTTPException(409, { message: 'Escolha uma automação publicada e ligada.' })
  await ensureWorkflow(c.env, runId)
  await recordMessage(c.env, { id: `run-${runId}`, workspaceId, conversationId: id, direction: 'out', sender: 'system', text: 'Automação iniciada pela equipe.' })
  return c.json(await notifyConversation(c.env, workspaceId, id), 201)
})
/** Lembrete da conversa: data no futuro (até 1 ano) e nota opcional; null tira o lembrete. */
inbox.post('/conversations/:id/reminder', async c => {
  const workspaceId = c.var.principal.workspaceId, id = identifier.parse(c.req.param('id'))
  await getConversation(c.env, workspaceId, id)
  const body = inboxReminderSchema.parse(await json(c.req.raw))
  const at = body.at === null ? null : Date.parse(body.at)
  if (at !== null && (at <= Date.now() || at > Date.now() + 365 * 86400_000)) throw new HTTPException(400, { message: 'Escolha um horário futuro, em até um ano.' })
  await c.env.DB.prepare('UPDATE conversations SET reminder_at=?,reminder_note=?,reminder_by=? WHERE workspace_id=? AND id=?')
    .bind(at, at === null ? null : body.note || null, at === null ? null : c.var.principal.userId, workspaceId, id).run()
  return c.json(await notifyConversation(c.env, workspaceId, id))
})
for (const action of ['read', 'unread', 'status', 'assign'] as const) {
  inbox.post(`/conversations/:id/${action}`, async c => {
    const workspaceId = c.var.principal.workspaceId, id = identifier.parse(c.req.param('id'))
    await getConversation(c.env, workspaceId, id)
    if (action === 'read') {
      const raw = await c.req.text()
      if (raw.trim()) { try { z.object({}).strict().parse(JSON.parse(raw)) } catch { throw new HTTPException(400) } }
      await c.env.DB.prepare('UPDATE conversations SET unread=0,unread_count=0 WHERE workspace_id=? AND id=?').bind(workspaceId, id).run()
    } else if (action === 'unread') {
      await c.env.DB.prepare('UPDATE conversations SET unread=1,unread_count=max(unread_count,1) WHERE workspace_id=? AND id=?').bind(workspaceId, id).run()
    } else if (action === 'status') {
      const { status } = inboxStatusSchema.parse(await json(c.req.raw))
      await c.env.DB.prepare('UPDATE conversations SET status=? WHERE workspace_id=? AND id=?').bind(status, workspaceId, id).run()
    } else {
      const { member_id } = inboxAssignSchema.parse(await json(c.req.raw))
      if (member_id !== null && !await c.env.DB.prepare('SELECT id FROM workspace_members WHERE workspace_id=? AND id=? AND (inbox_seat=1 OR role=\'owner\')')
        .bind(workspaceId, member_id).first()) throw new HTTPException(400, { message: 'Escolha um membro com acesso à Caixa de entrada.' })
      await c.env.DB.prepare('UPDATE conversations SET assignee_id=? WHERE workspace_id=? AND id=?').bind(member_id, workspaceId, id).run()
      if (member_id !== null) {
        await queueAssignedAlert(c.env, workspaceId, id, member_id, c.var.memberId).catch(() => null)
        await drainMemberAlerts(c.env).catch(() => null)
      }
    }
    return c.json(await notifyConversation(c.env, workspaceId, id))
  })
}
