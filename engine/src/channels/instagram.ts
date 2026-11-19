import type { IntegrationEnv, InboundEvent as QueuedEvent } from '../integrations'
import type { AdapterEnv } from './core/credentials'
import { stableId } from '../flow/types'
import { notifyConversation } from '../inbox/service'
import { effectiveProfile } from './core/profile-merge'
import { canSend } from './policy'
import { viewCredentials } from './core/credentials'
import { deliverAutomation, storedConnection } from './core/delivery'
import { igsid } from './instagram-graph'
import { instagramUnified } from './instagram-unified'
import type { ProviderAdapter } from './contract'
import type { ChannelAdapter, ContactChannelState, InboundEvent, OutboundMessage, SendContext, SendResult } from './types'
import { firstInboundOptIn } from './core/consent'

export { INSTAGRAM_GRAPH_VERSION } from './instagram-graph'
const rejected = (code: string): SendResult => ({ ok: false, reason: 'rejected', code, detail: 'Instagram rejected send; check channel configuration' })
const liveFetch = ((input, init) => fetch(input, init)) as typeof fetch
/** The stored row carries the connection's settings (apiBase) and capability override; the account id comes from the credentials. */
const connectionOf = (env: AdapterEnv, channelId: string, workspaceId: string) =>
  storedConnection(env, 'instagram', workspaceId, channelId, { external_id: viewCredentials('instagram', env).accountId ?? '' })

/** ChannelAdapter facade over the Instagram provider da conexão (login unificado), for callers that still hold the pre-layer interface
 * (the flow executor). Transport and parsing live in instagram-graph.ts; sending goes through core/delivery.
 * What stays here is Instagram's own bookkeeping: the identity rows, the 24h/7d windows and the read-receipt correlation. */
export class InstagramAdapter implements ChannelAdapter {
  constructor(private readonly env: AdapterEnv, private readonly provider: ProviderAdapter = instagramUnified) {}
  capabilities() { return effectiveProfile('instagram', this.provider.id) }
  canSend(contact: ContactChannelState, now: number, intent: 'automation' | 'human' | 'broadcast') {
    // Private comment replies are a separate transport, never an automation window bypass.
    return canSend({ ...this.capabilities(), commentReply: null }, contact, now, intent)
  }
  fit: ChannelAdapter['fit'] = (message, caps) => this.provider.fit(message, caps)
  async send(ctx: SendContext, message: OutboundMessage): Promise<SendResult> {
    if (!ctx.mode.ok) return ctx.mode
    // deliverAutomation records automation output. HUMAN_AGENT must never label automated messages.
    if (ctx.mode.mode !== 'free') return { ok: false, reason: 'unsupported', detail: 'Human Agent requires a separate human reply path and permission' }
    const credentials = viewCredentials('instagram', this.env)
    const connection = await connectionOf(this.env, ctx.channelId, ctx.run.workspace_id)
    let nodeId = ''
    // Consent and window are re-read from the database for every part, right before the claim and again before the network call.
    const guard = async () => {
      const row = await this.env.DB.prepare(`SELECT cc.opted_in,cc.window_expires_at,c.status FROM contact_channels cc
        JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
        JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id
        WHERE cc.workspace_id=? AND cc.channel_id=? AND cc.contact_id=? AND cc.external_user_id=?
        AND ch.type='instagram' AND ch.status='connected' AND ch.external_id=?`)
        .bind(ctx.run.workspace_id, ctx.channelId, ctx.run.contact_id, ctx.externalUserId, credentials.accountId)
        .first<{ opted_in: number; window_expires_at: number | null; status: string }>()
      if (!row) return rejected('channel_not_configured')
      const mode = canSend({ ...connection.profile, commentReply: null }, { optedIn: !!row.opted_in && row.status === 'subscribed',
        windowExpiresAt: row.window_expires_at, humanWindowExpiresAt: null }, Date.now(), 'automation')
      if (!mode.ok) return mode
    }
    return deliverAutomation(this.env, { connection, provider: this.provider, credentials: async () => credentials }, ctx, message, {
      // Only an IGSID of this very run, on the connected account that is the configured one.
      prepare: async () => {
        if (ctx.run.channel_type !== 'instagram' || !igsid.safeParse(ctx.externalUserId).success) return rejected('context_mismatch')
        const state = await this.env.DB.prepare(`SELECT r.current_node_id FROM flow_runs r JOIN channels ch
          ON ch.workspace_id=r.workspace_id AND ch.id=r.channel_id WHERE r.workspace_id=? AND r.id=? AND r.contact_id=?
          AND r.channel_id=? AND ch.type='instagram' AND ch.status='connected' AND ch.external_id=?`)
          .bind(ctx.run.workspace_id, ctx.runId, ctx.run.contact_id, ctx.channelId, credentials.accountId)
          .first<{ current_node_id: string | null }>()
        if (!state?.current_node_id) return rejected('channel_not_configured')
        nodeId = state.current_node_id
      },
      guard,
      afterSend: async (sent) => {
        await this.env.DB.prepare(`UPDATE messages SET content=json_set(content,'$.instagram',
          coalesce(json_extract(content,'$.instagram'),json(?))) WHERE workspace_id=? AND id=?`)
          .bind(JSON.stringify({ runId: ctx.runId, nodeId }), ctx.run.workspace_id, `out-${await stableId(sent.runId, String(sent.step), String(sent.part))}`).run()
      },
    })
  }
}

/** Janela padrão: 24 horas. Na primeira mensagem depois de um clique em anúncio Click-to-Direct (referral source=ADS, lida como origin 'ad'), até 7 dias
 * (docs-meta-instagram, messaging-api.md, 'Send a message'). Se a Meta encerrar antes, o envio volta como fora da janela. */
const standardWindowMs = (input: { kind: string; origin?: { kind?: string } }) => input.kind === 'message' && input.origin?.kind === 'ad' ? 7 * 86400000 : 86400000

/** Provider identity is the IGSID, scoped by workspace and channel; no username/phone merge. */
export async function syncInstagramContact(event: QueuedEvent, input: Extract<InboundEvent, { kind: 'message' | 'click' | 'story_mention' }> | Extract<InboundEvent, { kind: 'optin' | 'optout' | 'referral' }>, env: AdapterEnv, provider: ProviderAdapter = instagramUnified) {
  // `missing`: o perfil ainda não foi buscado (lido junto com a identidade, uma ida a menos antes da resposta).
  let identity = await env.DB.prepare(`SELECT id,contact_id,username IS NULL AS missing FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?`)
    .bind(event.workspaceId, event.channelId, input.externalUserId).first<{ id: string; contact_id: string; missing: number }>()
  const inboundId = JSON.stringify([event.provider, event.channelId, event.eventId])
  const at = Math.min('occurredAt' in input ? input.occurredAt ?? event.receivedAt : event.receivedAt, event.receivedAt)
  const private_ = input.kind === 'message' || input.kind === 'story_mention' || input.kind === 'referral'   // quem escreve, menciona ou abre o ig.me ganha identidade
  if (!identity && private_) {
    const contactId = `ig-${await stableId(event.workspaceId, event.channelId, input.externalUserId)}`
    const channelContactId = `ig-${await stableId(event.channelId, input.externalUserId)}`
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO contacts(id,workspace_id,optin_source) VALUES (?,?,'instagram') ON CONFLICT(id) DO NOTHING`)
        .bind(contactId, event.workspaceId),
      env.DB.prepare(`INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id)
        VALUES (?,?,?,?,?) ON CONFLICT(channel_id,external_user_id) DO NOTHING`)
        .bind(channelContactId, event.workspaceId, contactId, event.channelId, input.externalUserId),
    ])
    identity = await env.DB.prepare(`SELECT id,contact_id,username IS NULL AS missing FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?`)
      .bind(event.workspaceId, event.channelId, input.externalUserId).first<{ id: string; contact_id: string; missing: number }>()
  }
  if (!identity) return
  if (private_) await fillInstagramProfile(env, event, identity, input.externalUserId, provider)
  // Referral isolado (link ig.me aberto numa conversa que já existia): só identifica o contato. Não é mensagem: sem janela de 24 horas, sem opt-in, sem primeira entrada.
  if (input.kind === 'referral') return
  // Quem nasceu de um comentário não tem consentimento nem janela. O toque no botão da resposta privada é a primeira resposta da pessoa: vale como ela (abre o consentimento e a janela).
  const tappedOpening = input.kind === 'click' && /^b:[a-f0-9]{24}$/.test(input.payload) && !!await env.DB.prepare(`SELECT 1 FROM button_tokens b JOIN flow_runs r ON r.workspace_id=b.workspace_id AND r.id=b.run_id
    WHERE b.workspace_id=? AND b.token=? AND r.channel_id=? AND r.contact_id=? AND r.comment_context IS NOT NULL`)
    .bind(event.workspaceId, input.payload.slice(2), event.channelId, identity.contact_id).first()
  await env.DB.batch([
    // O toque segue a mesma regra de horário do START/STOP (consent_changed_at): um toque mais antigo que o último STOP não muda nada; um toque aplicado grava o horário.
    // Opt-in devolvido (toque ou primeira mensagem) limpa a marca de "pediu para sair".
    env.DB.prepare(`UPDATE contact_channels SET ${firstInboundOptIn(private_, at, tappedOpening).sql},
      window_expires_at=max(coalesce(window_expires_at,0),?),
      human_window_expires_at=max(coalesce(human_window_expires_at,0),?),
      first_inbound_id=CASE WHEN ?=1 THEN coalesce(first_inbound_id,?) ELSE first_inbound_id END WHERE workspace_id=? AND id=?`)
      .bind(...firstInboundOptIn(private_, at, tappedOpening).binds, at + standardWindowMs(input), at + 7 * 86400000, private_ ? 1 : 0, inboundId, event.workspaceId, identity.id),
    env.DB.prepare(`UPDATE contacts SET last_input_text=CASE WHEN coalesce(last_interaction_at,0)<=? THEN coalesce(?,last_input_text) ELSE last_input_text END,
      last_interaction_at=max(coalesce(last_interaction_at,0),?) WHERE workspace_id=? AND id=?`)
      .bind(at, input.kind === 'message' ? input.text ?? null : null, at, event.workspaceId, identity.contact_id),
  ])
}

/** Name, username and photo come from the provider's profile lookup, once per contact (a channel row without a username yet). */
async function fillInstagramProfile(env: AdapterEnv, event: QueuedEvent, identity: { id: string; contact_id: string; missing: number }, externalUserId: string, provider: ProviderAdapter) {
  const workspaceId = event.workspaceId
  const credentials = viewCredentials('instagram', env)
  if (!provider.credentialsSchema.safeParse(credentials).success) return
  if (!identity.missing) return
  const profile = await provider.fetchProfile!({ connection: await connectionOf(env, event.channelId, workspaceId), credentials, fetch: liveFetch },
    { externalUserId, addressKind: 'igsid' })
  if (!profile) return
  await env.DB.batch([
    env.DB.prepare(`UPDATE contact_channels SET username=?,channel_fields=coalesce(?,channel_fields) WHERE workspace_id=? AND id=?`)
      .bind(profile.username ?? '', profile.channelFields ? JSON.stringify(profile.channelFields) : null, workspaceId, identity.id),
    env.DB.prepare(`UPDATE contacts SET first_name=coalesce(first_name,?),last_name=coalesce(last_name,?),
      profile_pic_url=coalesce(?,profile_pic_url) WHERE workspace_id=? AND id=?`)
      .bind(profile.firstName ?? null, profile.lastName ?? null, profile.avatar && 'url' in profile.avatar ? profile.avatar.url : null, workspaceId, identity.contact_id),
  ])
}

/** Read events reference an exact message, not a watermark or the run's current node. */
export async function recordInstagramReceipt(event: QueuedEvent, receipt: Extract<InboundEvent, { kind: 'receipt' }>, env: IntegrationEnv) {
  if (receipt.status !== 'read') return
  const row = await env.DB.prepare(`SELECT m.id,m.conversation_id,r.id AS run_id,r.contact_id,v.automation_id,
    json_extract(m.content,'$.instagram.nodeId') AS node_id
    FROM flow_outbound o JOIN flow_runs r ON r.id=o.run_id
    JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id
    JOIN contact_channels cc ON cc.workspace_id=r.workspace_id AND cc.contact_id=r.contact_id AND cc.channel_id=r.channel_id
    JOIN messages m ON m.workspace_id=r.workspace_id AND m.external_message_id=?||cc.external_user_id||':'||o.external_message_id
    WHERE r.workspace_id=? AND r.channel_id=? AND o.external_message_id=?`)
    .bind(`instagram:${event.channelId}:`, event.workspaceId, event.channelId, receipt.externalMessageId)
    .first<{ id: string; conversation_id: string; run_id: string; contact_id: string; automation_id: string; node_id: string | null }>()
  if (!row) throw new Error('Instagram receipt is not yet correlated')
  // Mensagem enviada sem a marca do passo (anterior a ela): a leitura ainda atualiza o estado na caixa de entrada, só não conta no cartão.
  await env.DB.batch([
    ...(row.node_id ? [env.DB.prepare(`INSERT INTO node_events(workspace_id,automation_id,node_id,contact_id,flow_run_id,type,created_at)
      VALUES (?,?,?,?,?,'read',?) ON CONFLICT DO NOTHING`)
      .bind(event.workspaceId, row.automation_id, row.node_id, row.contact_id, row.run_id, receipt.occurredAt ?? event.receivedAt)] : []),
    env.DB.prepare(`UPDATE messages SET content=json_set(content,'$.instagramStatus','read','$.status','delivered'),delivery_status='read' WHERE workspace_id=? AND id=?`)
      .bind(event.workspaceId, row.id),
  ])
  await notifyConversation(env, event.workspaceId, row.conversation_id)
}
