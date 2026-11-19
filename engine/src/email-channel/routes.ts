import { marketingKey, resendDomain, saveMarketingKey } from './marketing-provider'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { AuthVariables } from '../team'
import { authorize } from '../permissions'
import { connectionRuntime } from '../channels/core/runtime'
import {
  emailConnection,
  emailContact,
  getSettings,
  initialize,
  normalizeEmail,
  publicSender,
  type Sender,
  type EmailEnv,
} from './store'
import { sendEmailPart, mirrorOutbound, emailEvent, type StoredEmail } from './service'
import { receiveReply } from './receive'
import { emailManagement } from './management'
import { unsubscribeConfirmation } from './unsubscribe-page'
import { changeConsent, newIdentityConsent } from '../channels/core/consent'
export const emailRoutes = new Hono<{
  Bindings: EmailEnv
  Variables: AuthVariables
}>()
export const publicEmailRoutes = new Hono<{ Bindings: EmailEnv }>()
const address = z.email().max(254).transform(normalizeEmail)
export const emailSenderSchema = z
  .object({
    address,
    name: z.string().trim().min(1).max(128),
    replyTo: address.optional(),
    branding: z.boolean().optional(),
  })
  .strict()
export const emailSenderPatchSchema = emailSenderSchema
  .omit({ address: true })
  .partial()
  .extend({ isDefault: z.boolean().optional() })
  .strict()
const interaction = z
  .object({
    automationId: z.string().min(1).max(128).optional(),
    actions: z
      .array(
        z
          .object({
            type: z.enum(['add_tag', 'remove_tag']),
            tag_id: z.string().min(1).max(128),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict()
export const emailDraftSchema = z
  .object({
    name: z.string().trim().max(200).optional(),
    id: z.string().max(128).optional(),
    senderId: z.string().max(128).optional(),
    to: address.optional(),
    subject: z.string().max(998),
    preheader: z.string().max(998).optional(),
    text: z.string().max(100000),
    html: z.string().max(350000).optional(),
    design: z.unknown().optional(),
    onOpen: interaction.extend({ mode: z.enum(['once', 'every']) }).optional(),
    linkActions: z
      .array(interaction.extend({ url: z.url({ protocol: /^https?$/ }) }))
      .max(50)
      .optional(),
    consent: z.boolean().optional(),
  })
  .strict()
const freeDomains = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.com.br',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'bol.com.br',
  'uol.com.br',
])
const parseBody = async (c: { req: { json: () => Promise<unknown> } }) => {
  try {
    return await c.req.json()
  } catch {
    throw new HTTPException(400, { message: 'JSON inválido.' })
  }
}
export const emailSettingsPatchSchema = z
  .object({
    defaultSenderId: z.string().optional(),
    company: z
      .object({
        name: z.string().trim().max(200),
        address: z.string().trim().max(1000),
      })
      .optional(),
    paused: z.boolean().optional(),
    thresholds: z
      .object({
        bounce: z.number().min(0).max(1),
        unsubscribe: z.number().min(0).max(1),
        complaint: z.number().min(0).max(1),
      })
      .optional(),
  })
  .strict()
export const emailSenderVerifySchema = z
  .object({
    stage: z.enum(['address', 'dns', 'resend']).default('address'),
    warmupAccepted: z.boolean().optional(),
  })
  .strict()
export const emailDevInboundSchema = z
  .object({
    from: address,
    to: address,
    messageId: z.string().min(1).max(512),
    inReplyTo: z.string().max(512).optional(),
    text: z.string().max(100000),
  })
  .strict()
export const emailDevEventSchema = z
  .object({
    id: z.string(),
    type: z.enum(['hard_bounce', 'soft_bounce', 'complaint', 'delivered']),
  })
  .strict()
export const emailDraftAutomationNodeSchema = z
  .object({
    automationId: z.string().min(1).max(128),
    nodeId: z.string().min(1).max(128),
  })
  .strict()
export const emailContactPatchSchema = z
  .object({
    address: address.optional(),
    optedIn: z.boolean().optional(),
    consent: z.boolean().optional(),
  })
  .strict()
export const emailTestSchema = emailDraftSchema.extend({ to: address, consent: z.literal(true) })
export const emailMarketingProviderSchema = z.object({ api_key: z.string().trim().regex(/^re_[A-Za-z0-9_]{8,200}$/, 'Chave do Resend inválida (começa com re_).') }).strict()
emailRoutes.use('*', async (c, next) => {
  authorize(c.var.principal, c.req.method === 'GET' ? 'read' : 'team')
  await next()
})
emailRoutes.route('/', emailManagement)
emailRoutes.get('/settings', async (c) => c.json(await getSettings(c.env, c.var.principal.workspaceId)))
emailRoutes.patch('/settings', async (c) => {
  const ws = c.var.principal.workspaceId
  await initialize(c.env, ws)
  const body = emailSettingsPatchSchema.parse(await parseBody(c))
  if (
    body.defaultSenderId &&
    !(await c.env.DB.prepare(
      "SELECT id FROM email_senders WHERE workspace_id=? AND id=? AND status='verified'",
    )
      .bind(ws, body.defaultSenderId)
      .first())
  )
    throw new HTTPException(400, {
      message: 'Escolha um remetente verificado deste workspace.',
    })
  const old = await c.env.DB.prepare('SELECT * FROM email_settings WHERE workspace_id=?')
    .bind(ws)
    .first<any>()
  await c.env.DB.prepare(
    'UPDATE email_settings SET default_sender_id=?,company_name=?,company_address=?,paused=?,pause_reason=?,bounce_threshold=?,unsubscribe_threshold=?,complaint_threshold=? WHERE workspace_id=?',
  )
    .bind(
      body.defaultSenderId ?? old.default_sender_id,
      body.company?.name ?? old.company_name,
      body.company?.address ?? old.company_address,
      body.paused === undefined ? old.paused : Number(body.paused),
      body.paused === undefined ? old.pause_reason : body.paused ? (old.paused ? old.pause_reason : 'manual') : null,
      body.thresholds?.bounce ?? old.bounce_threshold,
      body.thresholds?.unsubscribe ?? old.unsubscribe_threshold,
      body.thresholds?.complaint ?? old.complaint_threshold,
      ws,
    )
    .run()
  if (body.company?.name && body.company?.address) await emailConnection(c.env, ws)
  return c.json(await getSettings(c.env, ws))
})
emailRoutes.post('/senders', async (c) => {
  const ws = c.var.principal.workspaceId
  await initialize(c.env, ws)
  const input = emailSenderSchema.parse(await parseBody(c)),
    domain = input.address.split('@')[1]
  if (freeDomains.has(domain))
    throw new HTTPException(400, {
      message: 'Use um endereço do domínio da sua empresa. Provedores gratuitos não podem ser remetentes.',
    })
  if (
    await c.env.DB.prepare('SELECT id FROM email_senders WHERE workspace_id=? AND address=?')
      .bind(ws, input.address)
      .first()
  )
    throw new HTTPException(409, { message: 'Este remetente já existe.' })
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    'INSERT INTO email_senders(id,workspace_id,address,name,reply_to,branding,verification_token,verification_expires_at) VALUES (?,?,?,?,?,?,?,?)',
  )
    .bind(
      id,
      ws,
      input.address,
      input.name,
      input.replyTo ?? input.address,
      input.branding === false ? 0 : 1,
      crypto.randomUUID(),
      Date.now() + 3 * 86400_000,
    )
    .run()
  const sender = (await c.env.DB.prepare('SELECT * FROM email_senders WHERE workspace_id=? AND id=?')
    .bind(ws, id)
    .first<Sender>())!
  return c.json(publicSender(sender, null), 201)
})
emailRoutes.patch('/senders/:id', async (c) => {
  const ws = c.var.principal.workspaceId
  const sender = await c.env.DB.prepare('SELECT * FROM email_senders WHERE workspace_id=? AND id=?')
    .bind(ws, c.req.param('id'))
    .first<Sender>()
  if (!sender) throw new HTTPException(404, { message: 'Remetente não encontrado.' })
  const input = emailSenderPatchSchema.parse(await parseBody(c))
  if (input.isDefault && sender.status !== 'verified')
    throw new HTTPException(409, {
      message: 'Verifique o endereço antes de definir como padrão.',
    })
  await c.env.DB.prepare(
    'UPDATE email_senders SET name=?,reply_to=?,branding=? WHERE workspace_id=? AND id=?',
  )
    .bind(
      input.name ?? sender.name,
      input.replyTo ?? sender.reply_to,
      input.branding === undefined ? sender.branding : Number(input.branding),
      ws,
      sender.id,
    )
    .run()
  if (input.isDefault)
    await c.env.DB.prepare('UPDATE email_settings SET default_sender_id=? WHERE workspace_id=?')
      .bind(sender.id, ws)
      .run()
  return c.json((await getSettings(c.env, ws)).senders.find((v) => v.id === sender.id))
})
emailRoutes.post('/senders/:id/verify', async (c) => {
  const ws = c.var.principal.workspaceId
  const sender = await c.env.DB.prepare('SELECT * FROM email_senders WHERE workspace_id=? AND id=?')
    .bind(ws, c.req.param('id'))
    .first<Sender>()
  if (!sender) throw new HTTPException(404, { message: 'Remetente não encontrado.' })
  const input = emailSenderVerifySchema.parse(await parseBody(c))
  // Fora do desenvolvimento, com provedor de marketing configurado, o domínio é verificado de verdade no provedor.
  const providerKey = c.env.APP_ENV !== 'development' ? await marketingKey(c.env, ws) : null
  if (providerKey && input.stage !== 'resend') {
    const domain = sender.address.split('@')[1]!
    let state: Awaited<ReturnType<typeof resendDomain>>
    try { state = await resendDomain(providerKey, domain) } catch { throw new HTTPException(502, { message: 'O provedor de e-mail não respondeu. Tente de novo.' }) }
    if (input.stage === 'dns' && state.verified && !input.warmupAccepted) throw new HTTPException(400, { message: 'Aceite o aquecimento de reputação por 2 a 4 semanas.' })
    await c.env.DB.prepare('UPDATE email_senders SET status=?,dns=?,warmup_accepted=?,verification_expires_at=? WHERE workspace_id=? AND id=?')
      .bind(state.verified && input.stage === 'dns' ? 'verified' : 'dns_pending', JSON.stringify(state.records), state.verified && input.stage === 'dns' ? 1 : 0, Date.now() + 3 * 86400_000, ws, sender.id).run()
    return c.json((await getSettings(c.env, ws)).senders.find((v) => v.id === sender.id))
  }
  if (c.env.APP_ENV !== 'development')
    throw new HTTPException(503, {
      message:
        'Confirmação e checagem DNS precisam da configuração real do domínio no Cloudflare. Nenhuma verificação foi simulada.',
    })
  if (input.stage === 'resend') {
    await c.env.DB.prepare(
      "UPDATE email_senders SET status='unverified',verification_token=?,verification_expires_at=? WHERE workspace_id=? AND id=?",
    )
      .bind(crypto.randomUUID(), Date.now() + 3 * 86400_000, ws, sender.id)
      .run()
  } else if (input.stage === 'address') {
    // Fake guide explicitly labels development DNS: no invented production DKIM/SPF is presented as authoritative.
    const dns = [
      {
        type: 'TXT',
        name: '_email-verification',
        value: `dev-verification=${sender.verification_token}`,
      },
      {
        type: 'MX',
        name: '@',
        value: 'Configure Email Routing no painel Cloudflare',
      },
      { type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=none' },
    ]
    await c.env.DB.prepare(
      "UPDATE email_senders SET status='dns_pending',dns=?,verification_expires_at=? WHERE workspace_id=? AND id=?",
    )
      .bind(JSON.stringify(dns), Date.now() + 3 * 86400_000, ws, sender.id)
      .run()
  } else {
    if (sender.status !== 'dns_pending')
      throw new HTTPException(409, {
        message: 'Confirme o endereço antes de verificar o DNS.',
      })
    if (!sender.verification_expires_at || sender.verification_expires_at < Date.now()) {
      await c.env.DB.prepare("UPDATE email_senders SET status='failed' WHERE workspace_id=? AND id=?")
        .bind(ws, sender.id)
        .run()
      throw new HTTPException(409, {
        message: 'Prazo de 3 dias expirado. Reenvie a confirmação.',
      })
    }
    if (!input.warmupAccepted)
      throw new HTTPException(400, {
        message: 'Aceite o aquecimento de reputação por 2 a 4 semanas.',
      })
    await c.env.DB.prepare(
      "UPDATE email_senders SET status='verified',warmup_accepted=1 WHERE workspace_id=? AND id=?",
    )
      .bind(ws, sender.id)
      .run()
  }
  return c.json((await getSettings(c.env, ws)).senders.find((v) => v.id === sender.id))
})
emailRoutes.get('/drafts', async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT id,content,updated_at FROM email_drafts WHERE workspace_id=? ORDER BY updated_at DESC',
  )
    .bind(c.var.principal.workspaceId)
    .all<{ id: string; content: string; updated_at: number }>()
  return c.json(
    result.results.map((v) => ({
      ...JSON.parse(v.content),
      id: v.id,
      updatedAt: v.updated_at,
    })),
  )
})
emailRoutes.post('/drafts', async (c) => {
  const input = emailDraftSchema.parse(await parseBody(c)),
    ws = c.var.principal.workspaceId
  const id = input.id ?? crypto.randomUUID()
  if (
    input.id &&
    !(await c.env.DB.prepare('SELECT id FROM email_drafts WHERE workspace_id=? AND id=?')
      .bind(ws, id)
      .first())
  )
    throw new HTTPException(404, { message: 'Rascunho não encontrado.' })
  await c.env.DB.prepare(
    'INSERT INTO email_drafts(id,workspace_id,content,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at WHERE email_drafts.workspace_id=excluded.workspace_id',
  )
    .bind(id, ws, JSON.stringify(input), Date.now())
    .run()
  return c.json({ ...input, id })
})
emailRoutes.post('/test', async (c) => {
  const input = emailTestSchema.parse(await parseBody(c)),
    ws = c.var.principal.workspaceId
  if (c.env.APP_ENV !== 'development')
    throw new HTTPException(503, {
      message:
        'O teste de marketing pelo Cloudflare Email Service está disponível apenas em simulação local.',
    })
  const channel = await emailConnection(c.env, ws),
    contactId = await emailContact(c.env, ws, channel, input.to, true)
  await changeConsent(c.env.DB, { optedIn: true, where: { sql: 'workspace_id=? AND channel_id=? AND contact_id=?', binds: [ws, channel, contactId] } }).run()
  const rt = await connectionRuntime(c.env, ws, channel, { secrets: false })
  const result = await sendEmailPart(
    c.env,
    rt.connection,
    { kind: 'direct', externalUserId: input.to },
    {
      kind: 'text',
      text: input.text,
      email: {
        subject: input.subject,
        preheader: input.preheader,
        html: input.html,
        senderId: input.senderId,
        onOpen: input.onOpen,
        linkActions: input.linkActions,
      },
    },
    'automation',
  )
  if (!result.ok)
    throw new HTTPException(409, {
      message: 'detail' in result ? result.detail : `Envio bloqueado: ${result.reason}`,
    })
  const mail = (await c.env.DB.prepare('SELECT * FROM email_messages WHERE workspace_id=? AND message_id=?')
    .bind(ws, result.externalId)
    .first<StoredEmail>())!
  const conversationId = await mirrorOutbound(c.env, mail)
  return c.json({
    id: mail.id,
    messageId: mail.message_id,
    to: mail.recipient,
    subject: mail.subject,
    simulated: true,
    conversationId,
    contactId,
  })
})
emailRoutes.get('/dev/outbox', async (c) => {
  if (c.env.APP_ENV !== 'development') throw new HTTPException(404)
  const rows = await c.env.DB.prepare(
    'SELECT id,message_id AS messageId,recipient AS "to",reply_to AS replyTo,subject,html,text,status FROM email_messages WHERE workspace_id=? ORDER BY created_at DESC',
  )
    .bind(c.var.principal.workspaceId)
    .all()
  return c.json(rows.results)
})
emailRoutes.post('/dev/inbound', async (c) => {
  if (c.env.APP_ENV !== 'development') throw new HTTPException(404)
  const body = emailDevInboundSchema.parse(await parseBody(c))
  // The dev simulator must not let a principal exercise another workspace's reply tokens.
  const token = body.to.match(/^reply\+([a-f0-9-]+)@/i)?.[1]
  const owner = await c.env.DB.prepare(
    'SELECT workspace_id FROM email_messages WHERE (message_id=? OR provider_message_id=? OR token=?) AND recipient=?',
  )
    .bind(body.inReplyTo ?? null, body.inReplyTo ?? null, token ?? null, body.from)
    .first<{ workspace_id: string }>()
  if (owner && owner.workspace_id !== c.var.principal.workspaceId) throw new HTTPException(404)
  return c.json(await receiveReply(c.env, body))
})
emailRoutes.post('/dev/events', async (c) => {
  if (c.env.APP_ENV !== 'development') throw new HTTPException(404)
  const input = emailDevEventSchema.parse(await parseBody(c))
  const mail = await c.env.DB.prepare('SELECT * FROM email_messages WHERE workspace_id=? AND id=?')
    .bind(c.var.principal.workspaceId, input.id)
    .first<StoredEmail>()
  if (!mail) throw new HTTPException(404)
  await emailEvent(c.env, mail, input.type)
  return c.json({ ok: true })
})
const findMail = async (env: EmailEnv, token: string) =>
  env.DB.prepare("SELECT * FROM email_messages WHERE token=? AND status='sent'")
    .bind(token)
    .first<StoredEmail>()
publicEmailRoutes.get('/open/:pixel', async (c) => {
  const mail = await findMail(c.env, c.req.param('pixel').replace(/\.gif$/, ''))
  if (!mail) throw new HTTPException(404)
  await emailEvent(c.env, mail, 'opened')
  const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (v) =>
    v.charCodeAt(0),
  )
  return c.body(gif, 200, {
    'content-type': 'image/gif',
    'cache-control': 'no-store',
  })
})
publicEmailRoutes.get('/click/:token/:link', async (c) => {
  const mail = await findMail(c.env, c.req.param('token'))
  if (!mail) throw new HTTPException(404)
  const link = await c.env.DB.prepare('SELECT url FROM email_message_links WHERE message_id=? AND link_id=?')
    .bind(mail.id, c.req.param('link'))
    .first<{ url: string }>()
  if (!link || !/^https?:\/\//i.test(link.url)) throw new HTTPException(404)
  await emailEvent(c.env, mail, 'clicked', link.url)
  return c.redirect(link.url, 302)
})
publicEmailRoutes.on(['GET', 'POST'], '/unsubscribe/:token', async (c) => {
  const mail = await findMail(c.env, c.req.param('token'))
  if (!mail) throw new HTTPException(404)
  const exists = await c.env.DB.prepare(
    "SELECT id FROM email_events WHERE message_id=? AND type='unsubscribed'",
  )
    .bind(mail.id)
    .first()
  if (!exists) await emailEvent(c.env, mail, 'unsubscribed')
  return c.html(unsubscribeConfirmation)
})

emailRoutes.post('/drafts/:id/automation-node', async (c) => {
  const ws = c.var.principal.workspaceId
  const input = emailDraftAutomationNodeSchema.parse(await parseBody(c))
  const draft = await c.env.DB.prepare('SELECT content FROM email_drafts WHERE workspace_id=? AND id=?')
    .bind(ws, c.req.param('id'))
    .first<{ content: string }>()
  const automation = await c.env.DB.prepare(
    'SELECT draft_graph FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL',
  )
    .bind(ws, input.automationId)
    .first<{ draft_graph: string }>()
  if (!draft || !automation)
    throw new HTTPException(404, {
      message: 'Rascunho ou automação não encontrado.',
    })
  const design = JSON.parse(draft.content),
    graph = JSON.parse(automation.draft_graph)
  const node = graph.nodes.find((n: { id: string }) => n.id === input.nodeId)
  if (!node || node.type !== 'message')
    throw new HTTPException(400, {
      message: 'Escolha um passo de mensagem desta automação.',
    })
  node.config = {
    ...node.config,
    email: {
      subject: design.subject,
      text: design.text,
      preheader: design.preheader,
      html: design.html,
      design: design.design,
      senderId: design.senderId,
      onOpen: design.onOpen,
      linkActions: design.linkActions,
    },
    blocks: [{ kind: 'text', text: design.text.slice(0, 4096) || 'E-mail' }],
  }
  // Grava só sobre o rascunho lido e fora da lixeira: uma edição salva ou um envio à lixeira no meio do caminho não é sobrescrito.
  const saved = await c.env.DB.prepare(
    'UPDATE automations SET draft_graph=?,has_unpublished_changes=1,updated_at=? WHERE workspace_id=? AND id=? AND deleted_at IS NULL AND draft_graph=? RETURNING id',
  )
    .bind(JSON.stringify(graph), Date.now(), ws, input.automationId, automation.draft_graph)
    .first()
  if (!saved)
    throw new HTTPException(409, {
      message: 'A automação mudou enquanto o e-mail era aplicado. Abra a automação de novo e tente outra vez.',
    })
  return c.json({
    automationId: input.automationId,
    nodeId: input.nodeId,
    hasUnpublishedChanges: true,
  })
})

emailRoutes.get('/contacts/:id', async (c) => {
  const ws = c.var.principal.workspaceId,
    id = c.req.param('id')
  // Existência, canais e métricas na mesma onda; sem contato, 404 e nada do que foi lido sai.
  const [contact, channels, metrics] = await Promise.all([
    c.env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND id=? AND status<>'deleted'")
      .bind(ws, id)
      .first(),
    c.env.DB.prepare(
      "SELECT cc.id,cc.channel_id,cc.external_user_id AS address,cc.opted_in AS optedIn FROM contact_channels cc JOIN channels ch ON ch.id=cc.channel_id AND ch.workspace_id=cc.workspace_id WHERE cc.workspace_id=? AND cc.contact_id=? AND ch.type='email'",
    )
      .bind(ws, id)
      .all(),
    c.env.DB.prepare(
      "SELECT max(CASE WHEN type='opened' THEN created_at END) AS lastOpenedAt,max(CASE WHEN type='clicked' THEN created_at END) AS lastClickedAt,sum(CASE WHEN type='opened' THEN 1 ELSE 0 END) AS opens,sum(CASE WHEN type='clicked' THEN 1 ELSE 0 END) AS clicks FROM email_events WHERE workspace_id=? AND contact_id=?",
    )
      .bind(ws, id)
      .first<any>(),
  ])
  if (!contact) throw new HTTPException(404)
  const opens = metrics?.opens ?? 0,
    clicks = metrics?.clicks ?? 0
  return c.json({
    channels: channels.results,
    metrics: { ...metrics, opens, clicks },
    segment: opens ? (clicks ? 'opened_clicked' : 'opened_not_clicked') : 'not_opened',
  })
})
emailRoutes.patch('/contacts/:id', async (c) => {
  const ws = c.var.principal.workspaceId,
    id = c.req.param('id')
  const input = emailContactPatchSchema.parse(await parseBody(c))
  if (
    !(await c.env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND id=? AND status<>'deleted'")
      .bind(ws, id)
      .first())
  )
    throw new HTTPException(404)
  if (input.optedIn === true && !input.consent)
    throw new HTTPException(400, {
      message: 'Confirme o consentimento para marketing por e-mail.',
    })
  const old = await c.env.DB.prepare(
    "SELECT cc.* FROM contact_channels cc JOIN channels ch ON ch.id=cc.channel_id AND ch.workspace_id=cc.workspace_id WHERE cc.workspace_id=? AND cc.contact_id=? AND ch.type='email' LIMIT 1",
  )
    .bind(ws, id)
    .first<{
      external_user_id: string
      channel_id: string
      opted_in: number
    }>()
  if (input.address) {
    const duplicate = await c.env.DB.prepare(
      "SELECT cc.contact_id FROM contact_channels cc JOIN channels ch ON ch.id=cc.channel_id AND ch.workspace_id=cc.workspace_id WHERE cc.workspace_id=? AND ch.type='email' AND lower(cc.external_user_id)=? AND cc.contact_id<>?",
    )
      .bind(ws, input.address, id)
      .first()
    if (duplicate)
      throw new HTTPException(409, {
        message: 'Este endereço já pertence a outro contato de e-mail.',
      })
    if (old)
      await c.env.DB.prepare(
        "UPDATE contact_channels SET external_user_id=? WHERE workspace_id=? AND contact_id=? AND channel_id IN (SELECT id FROM channels WHERE workspace_id=? AND type='email')",
      )
        .bind(input.address, ws, id, ws)
        .run()
    else {
          const channel = await emailConnection(c.env, ws)
      await c.env.DB.prepare(
        'INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in,consent_changed_at) VALUES (?,?,?,?,?,?,?)',
      )
        .bind(crypto.randomUUID(), ws, id, channel, input.address, ...Object.values(newIdentityConsent(!!input.optedIn)))
        .run()
    }
  }
  if (input.optedIn !== undefined)
    await changeConsent(c.env.DB, { optedIn: input.optedIn, where: { sql: "workspace_id=? AND contact_id=? AND channel_id IN (SELECT id FROM channels WHERE workspace_id=? AND type='email')", binds: [ws, id, ws] } }).run()
  const cc = await c.env.DB.prepare(
    "SELECT cc.channel_id FROM contact_channels cc JOIN channels ch ON ch.id=cc.channel_id AND ch.workspace_id=cc.workspace_id WHERE cc.workspace_id=? AND cc.contact_id=? AND ch.type='email' LIMIT 1",
  )
    .bind(ws, id)
    .first<{ channel_id: string }>()
  if (cc) {
    const { ensureConversation, recordMessage } = await import('../inbox/service')
    const conversationId = await ensureConversation(c.env, ws, id, cc.channel_id)
    if (input.address && input.address !== old?.external_user_id)
      await recordMessage(c.env, {
        workspaceId: ws,
        conversationId,
        direction: 'out',
        sender: 'system',
        text: `E-mail do contato alterado: ${old?.external_user_id ?? 'não definido'} → ${input.address}`,
      })
    if (input.address && input.address !== old?.external_user_id) {
      const { runEmailFieldRules } = await import('./events')
      await runEmailFieldRules(c.env, ws, id, cc.channel_id, old?.external_user_id ?? null, input.address)
    }
    if (input.optedIn !== undefined)
      await recordMessage(c.env, {
        workspaceId: ws,
        conversationId,
        direction: 'out',
        sender: 'system',
        text: input.optedIn ? 'Opt-in de e-mail confirmado' : 'Descadastrado do marketing por e-mail',
      })
  }
  return c.json({ ok: true })
})
emailRoutes.get('/metrics', async (c) => {
  const ws = c.var.principal.workspaceId
  const broadcastId = z.string().min(1).max(128).optional().parse(c.req.query('broadcastId'))
  const selection =
    "SELECT rowid AS creation_order,* FROM email_messages WHERE workspace_id=? AND (? IS NULL OR json_extract(metadata,'$.source.broadcastId')=?)"
  const first = broadcastId
    ? await c.env.DB.prepare(
        `SELECT json_extract(metadata,'$.source.nodeId') AS nodeId FROM (${selection}) WHERE json_extract(metadata,'$.source.nodeId') IS NOT NULL ORDER BY created_at,creation_order LIMIT 1`,
      )
        .bind(ws, broadcastId, broadcastId)
        .first<{ nodeId: string }>()
    : null
  const [rows, denominator] = await Promise.all([
    c.env.DB.prepare(
      `WITH selected AS (${selection}) SELECT e.type,count(*) AS total,count(DISTINCT e.contact_id) AS contacts,count(DISTINCT e.message_id) AS messages FROM email_events e JOIN selected m ON m.id=e.message_id AND m.workspace_id=e.workspace_id WHERE e.type<>'clicked' OR ? IS NULL OR json_extract(m.metadata,'$.source.nodeId')=? GROUP BY e.type`,
    )
      .bind(ws, broadcastId ?? null, broadcastId ?? null, first?.nodeId ?? null, first?.nodeId ?? null)
      .all<{ type: string; total: number; contacts: number; messages: number }>(),
    c.env.DB.prepare(
      `SELECT count(DISTINCT contact_id) AS n FROM (${selection}) WHERE status='sent' AND (? IS NULL OR json_extract(metadata,'$.source.nodeId')=?)`,
    )
      .bind(ws, broadcastId ?? null, broadcastId ?? null, first?.nodeId ?? null, first?.nodeId ?? null)
      .first<{ n: number }>(),
  ])
  const counts = Object.fromEntries(rows.results.map((v) => [v.type, v]))
  const clicked = counts.clicked?.contacts ?? 0
  return c.json({
    sent: counts.sent?.messages ?? 0,
    delivered: counts.delivered?.messages ?? 0,
    opened: counts.opened?.contacts ?? 0,
    clicked,
    ctr: denominator?.n ? clicked / denominator.n : 0,
    scope: broadcastId ? 'broadcast' : 'workspace',
    firstNodeId: first?.nodeId ?? null,
    definitions: {
      delivered: 'Aceito pelo servidor destinatário, quando informado pelo provedor.',
      opened: 'Pixel carregado pelo cliente de e-mail; imagens bloqueadas não são contadas.',
      ctr: 'Contatos únicos que clicaram divididos pelos destinatários únicos. Em uma transmissão, os cliques e a base do CTR usam somente o primeiro nó.',
    },
  })
})

/** Provedor de marketing: guarda a chave (cifrada) ou remove; a resposta só diz se há chave. */
emailRoutes.get('/marketing-provider', async (c) => c.json({ configured: !!(await marketingKey(c.env, c.var.principal.workspaceId)) }))
emailRoutes.put('/marketing-provider', async (c) => {
  const { api_key } = emailMarketingProviderSchema.parse(await parseBody(c))
  await saveMarketingKey(c.env, c.var.principal.workspaceId, api_key)
  return c.json({ configured: true })
})
emailRoutes.delete('/marketing-provider', async (c) => { await saveMarketingKey(c.env, c.var.principal.workspaceId, null); return c.json({ configured: false }) })
