import { env } from 'cloudflare:workers'
import { seedAuth } from './auth-helpers'
import { emailConnection, emailContact, initialize } from '../src/email-channel/store'
import { describe, expect, it, vi } from 'vitest'
import { cloudflareEmail } from '../src/channels/cloudflare-email'
import { EmailAdapter } from '../src/channels/email-adapter'
import { emailMessageForRun } from '../src/channels/email-design'
import { listConnections } from '../src/channels/core/connections'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import { resolveProviderAdapter } from '../src/channels/registry'
import type { Connection, ProviderCtx } from '../src/channels/contract'

const profile = effectiveProfile('email', 'cloudflare_email')
const connection: Connection = { id: 'mail', workspaceId: 'w', kind: 'email', provider: 'cloudflare_email', externalId: 'oi@example.test', displayName: 'Equipe', status: 'connected', settings: { senderAddress: 'oi@example.test', senderName: 'Equipe', replyTo: 'respostas@example.test' }, profile }
const context = () => ({ connection, credentials: {}, target: { kind: 'direct' as const, externalUserId: 'ana@example.test' }, fetch: vi.fn(), bindings: { email: { send: vi.fn(async () => ({ messageId: '<sent@example.test>' })) } } })

describe('Cloudflare Email: contrato e regras', () => {
  it('usa conteúdo de e-mail do snapshot publicado do nó atual, mantendo os tokens de personalização', async () => {
    const bind = vi.fn(() => ({ first: async () => ({ current_node_id: 'm' }) }))
    const env = { DB: { prepare: () => ({ bind }) } }
    const ctx = { runId: 'r', channelId: 'mail', run: { workspace_id: 'w', contact_id: 'c', automation_id: 'auto', graph: JSON.stringify({ nodes: [{ id: 'm', config: { email: { text: 'Corpo completo', subject: 'Olá {{first_name|cliente}}', html: '<p>{{email}}</p>', preheader: 'Resumo', senderId: 'sender', onOpen: { mode: 'once', actions: [{ type: 'add_tag', tag_id: 'opened' }] } } } }] }) } }
    expect(await emailMessageForRun(env as never, ctx as never, { kind: 'text', text: 'Corpo' })).toMatchObject({ kind: 'text', text: 'Corpo completo', email: { subject: 'Olá {{first_name|cliente}}', html: '<p>{{email}}</p>', senderId: 'sender', source: { automationId: 'auto', nodeId: 'm' }, onOpen: { mode: 'once' } } })
    expect(bind).toHaveBeenCalledWith('w', 'r', 'c', 'mail')
  })
  it('mantém mensagem neutra de chamador genérico com grafo vazio, sem consultar nó de automação', async () => {
    const env = { DB: { prepare: vi.fn() } }
    const message = { kind: 'text' as const, text: 'Transmissão' }
    expect(await emailMessageForRun(env as never, { run: { graph: '{}' } } as never, message)).toEqual(message)
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })
  it('identifica a transmissão real no grafo vazio para métricas do primeiro nó', async () => {
    const env = { DB: { prepare: vi.fn() } }
    const message = { kind: 'text' as const, text: 'Transmissão' }
    expect(await emailMessageForRun(env as never, { run: { graph: '{}', automation_id: 'broadcast-campaign-42' } } as never, message)).toEqual({
      ...message, email: { subject: '', source: { broadcastId: 'campaign-42', automationId: 'broadcast-campaign-42', nodeId: 'broadcast-message' } },
    })
    expect(await emailMessageForRun(env as never, { run: { graph: '{}', automation_id: 'ordinary-42' } } as never, message)).toEqual(message)
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })
  it('facade envia HTML do snapshot publicado e registra resumo pelo assunto no Inbox', async () => {
    await seedAuth()
    await initialize(env, 'a')
    await env.DB.prepare("UPDATE email_settings SET company_name='Empresa',company_address='Rua de teste, 1' WHERE workspace_id='a'").run()
    const channelId = await emailConnection(env, 'a')
    const contactId = await emailContact(env, 'a', channelId, 'snapshot@example.test', true)
    const graph = JSON.stringify({ nodes: [{ id: 'm', config: { email: { subject: 'Assunto publicado', html: '<p>Corpo publicado</p>' }, blocks: [{ kind: 'text', text: 'Corpo publicado' }] } }], edges: [] })
    await env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('mail-v','a','auto-a',1,?)").bind(graph).run()
    await env.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id,current_node_id) VALUES ('mail-run','a',?,'mail-v',?,'m')").bind(contactId, channelId).run()
    const run = { id: 'mail-run', workspace_id: 'a', contact_id: contactId, channel_id: channelId, channel_type: 'email', automation_version_id: 'mail-v', automation_id: 'auto-a', graph, start_node_id: null, depth: 0, external_user_id: 'snapshot@example.test' }
    const adapter = new EmailAdapter(env)
    const result = await adapter.send({ run, runId: run.id, step: 0, part: 0, channelId, externalUserId: run.external_user_id, mode: { ok: true, mode: 'free' } }, { kind: 'text', text: 'Corpo publicado' })
    expect(result).toMatchObject({ ok: true })
    expect(await env.DB.prepare("SELECT subject,html FROM email_messages WHERE workspace_id='a'").first()).toMatchObject({ subject: 'Assunto publicado', html: expect.stringContaining('<p>Corpo publicado</p>') })
    const recorded = await env.DB.prepare("SELECT json_extract(content,'$.text') AS text FROM messages WHERE workspace_id='a' AND direction='out' AND source='automation'").first()
    expect(recorded).toEqual({ text: 'E-mail enviado: Assunto publicado' })
  })
  it('expõe ficha efetiva da conexão para a tela decidir por capacidade', async () => {
    const row = { id: 'mail', type: 'email', provider: 'cloudflare_email', settings: '{}', capabilities_override: JSON.stringify({ email: { html: false } }), has_credentials: 0 }
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [row] }) }) }) } }
    expect(await listConnections(env as never, 'w', 'https://example.test')).toMatchObject([{ profile: { email: { html: false, subjectMaxLength: 998 } } }])
  })
  it('registra ficha sem janela, com email/HTML/assunto e identidade por endereço', () => {
    expect(resolveProviderAdapter('email', 'cloudflare_email')).toBe(cloudflareEmail)
    expect(profile).toMatchObject({ window: null, identity: { key: 'email' }, email: { subjectMaxLength: 998, html: true, unsubscribe: 'marketing' }, inbound: { message: true, emailOpenClick: true } })
  })
  it('envia texto e HTML pelo binding uma vez, sem fetch nem segredo', async () => {
    const ctx = context()
    expect(await cloudflareEmail.send(ctx, { kind: 'text', text: 'Olá', email: { subject: 'Seu pedido', preheader: 'Novidades', html: '<p>Olá</p>' } })).toEqual({ ok: true, externalId: '<sent@example.test>', parts: 1 })
    expect(ctx.bindings.email.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: 'ana@example.test', from: { email: 'oi@example.test', name: 'Equipe' }, subject: 'Seu pedido', text: 'Olá', replyTo: 'respostas@example.test', html: expect.stringContaining('<p>Olá</p>') }))
    expect(ctx.fetch).not.toHaveBeenCalled()
  })
  it('converte botões URL em links nos corpos e preserva metadados', () => {
    const fitted = cloudflareEmail.fit({ kind: 'text', text: 'Olá', buttons: [{ type: 'url', title: 'Abrir', url: 'https://example.test' }], email: { subject: 'Assunto', html: '<p>Olá</p>' } }, profile)
    expect(fitted).toMatchObject({ messages: [{ kind: 'text', text: expect.stringContaining('https://example.test'), email: { subject: 'Assunto', html: expect.stringContaining('<a href="https://example.test">Abrir</a>') } }] })
  })
  it('recusa binding ausente, destinatário inválido, HTML grande e assunto com quebra de linha sem enviar', async () => {
    const ctx = context()
    expect(await cloudflareEmail.send({ ...ctx, bindings: undefined }, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: false, reason: 'rejected' })
    expect(await cloudflareEmail.send({ ...ctx, target: { kind: 'direct', externalUserId: 'errado' } }, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: false, reason: 'rejected' })
    expect(await cloudflareEmail.send(ctx, { kind: 'text', text: 'Oi', email: { subject: 'Oi\r\nBcc: x@example.test' } })).toMatchObject({ ok: false, reason: 'rejected' })
    expect(await cloudflareEmail.send(ctx, { kind: 'text', text: 'Oi', email: { subject: 'Oi', html: 'á'.repeat(3 * 1024 * 1024) } })).toMatchObject({ ok: false, reason: 'rejected' })
    expect(ctx.bindings.email.send).not.toHaveBeenCalled()
  })
  it('não retenta resultado incerto e oculta mensagem de erro do transporte', async () => {
    const ctx = context(); ctx.bindings.email.send.mockRejectedValue(new Error('secret string'))
    expect(await cloudflareEmail.send(ctx, { kind: 'text', text: 'Oi' })).toEqual({ ok: false, reason: 'uncertain', detail: 'Envio de e-mail sem confirmação; confira antes de reenviar.' })
    expect(ctx.bindings.email.send).toHaveBeenCalledTimes(1)
  })
  it('bloqueia marketing real pois Email Service só aceita transacional', async () => {
    const ctx = context()
    expect(await cloudflareEmail.send({ ...ctx, intent: 'broadcast' } as ProviderCtx & { target: typeof ctx.target }, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: false, reason: 'rejected', code: 'marketing_cloudflare_unsupported' })
    expect(ctx.bindings.email.send).not.toHaveBeenCalled()
  })
  it('descadastro bloqueia automações e transmissões; resposta humana continua disponível', () => {
    const adapter = new EmailAdapter({ DB: {} } as never)
    const state = { optedIn: false, windowExpiresAt: null, humanWindowExpiresAt: null }
    expect(adapter.canSend(state, Date.now(), 'automation')).toMatchObject({ ok: false, reason: 'not_opted_in' })
    expect(adapter.canSend(state, Date.now(), 'broadcast')).toMatchObject({ ok: false, reason: 'not_opted_in' })
    expect(adapter.canSend(state, Date.now(), 'human')).toEqual({ ok: true, mode: 'free' })
  })
  it('só aceita resposta validada no handler nativo; webhook HTTP genérico é recusado', async () => {
    const reply = { type: 'reply', messageId: '<in@example.test>', from: 'ANA@EXAMPLE.TEST', text: 'Obrigada', inReplyTo: '<sent@example.test>', verifiedReply: true }
    expect(cloudflareEmail.parseInbound(reply, connection)).toMatchObject([{ kind: 'message', from: { externalUserId: 'ana@example.test', addressKind: 'email' }, replyTo: '<sent@example.test>' }])
    expect(cloudflareEmail.parseInbound({ ...reply, verifiedReply: false }, connection)).toMatchObject([{ kind: 'ignored' }])
    expect(await cloudflareEmail.verifyWebhook({ method: 'POST', headers: new Headers(), query: new URLSearchParams(), body: new Uint8Array() }, { webhookSecret: '', credentials: {} })).toEqual({ ok: false, status: 403 })
  })
})
