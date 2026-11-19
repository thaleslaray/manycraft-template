import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { giveCredentials } from './credentials'
import { ensureConversation, recordMessage } from '../src/inbox/service'
import { ALERT_INTERVAL_MINUTES, drainMemberAlerts, handleAlertStart } from '../src/team-alerts'
import { actions } from '../src/flow/nodes'
import type { FlowEnv, Run } from '../src/flow/types'
import type { Env } from '../src/env'

const sent: { to: string; subject: string; text: string }[] = []
const telegram: { chat: string; text: string }[] = []
const bindings = { ...env, EMAIL: { send: vi.fn(async (m: { to: string; subject: string; text: string }) => { sent.push(m) }) }, EMAIL_FROM: 'avisos@exemplo.test' } as unknown as Env
const prod = { ...bindings, APP_ENV: 'production' } as Env
/** Desenvolvimento grava no outbox; produção usa o binding EMAIL: os dois contam como e-mail enviado. */
const emails = async () => [...sent, ...(await bindings.DB.prepare('SELECT recipient AS "to",subject,text FROM email_outbox').all<{ to: string; subject: string; text: string }>()).results]
const call = (path: string, method = 'GET', body?: unknown) => authenticatedRequest(path, 'a', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, undefined, bindings)
const inbound = (text = 'oi', id?: string) => recordMessage(bindings, { ...(id ? { id } : {}), workspaceId: 'a', conversationId: 'inbox-cc-a', direction: 'in', sender: 'contact', text })
const settings = (member: string, patch: Record<string, unknown>) => bindings.DB.prepare(
  `INSERT INTO member_alert_settings(member_id,workspace_id,email_enabled,chat_id,chat_channel_id,on_assigned_message,on_unassigned,on_assigned_to_me)
   VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET email_enabled=excluded.email_enabled,chat_id=excluded.chat_id,chat_channel_id=excluded.chat_channel_id,
   on_assigned_message=excluded.on_assigned_message,on_unassigned=excluded.on_unassigned,on_assigned_to_me=excluded.on_assigned_to_me`)
  .bind(member, 'a', patch.email ?? 1, patch.chat ?? null, patch.chat ? 'tg-a' : null, patch.assignedMessage ?? 0, patch.unassigned ?? 0, patch.toMe ?? 0).run()

beforeEach(async () => {
  sent.length = 0; telegram.length = 0
  await seedAuth()
  await bindings.DB.batch([
    bindings.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('user-a2','Bruno','bruno@example.test',1,0,0)`),
    bindings.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role,inbox_seat) VALUES ('member-a2','a','user-a2','editor',1)"),
    bindings.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id,display_name) VALUES ('tg-a','a','telegram','999','@avisos_bot')"),
  ])
  await giveCredentials(bindings, 'tg-a', { botToken: 'TESTONLY' })
  await ensureConversation(bindings, 'a', 'c-a', 'ch-a')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (String(input).includes('/sendMessage')) telegram.push({ chat: String(body.chat_id), text: body.text })
    return Response.json({ ok: true, result: { message_id: 1 } })
  })
})
afterEach(() => vi.restoreAllMocks())

it('mensagem em conversa atribuída avisa o responsável por e-mail e Telegram, respeitando a preferência', async () => {
  await bindings.DB.prepare("UPDATE conversations SET assignee_id='member-a2' WHERE id='inbox-cc-a'").run()
  await settings('member-a2', { chat: '777', assignedMessage: 1 })
  await settings('member-a', { assignedMessage: 1 })
  await inbound('Quero comprar')
  await drainMemberAlerts(prod)
  expect(await emails()).toEqual([expect.objectContaining({ to: 'bruno@example.test', text: expect.stringContaining('Quero comprar') })])
  expect(telegram).toEqual([{ chat: '777', text: expect.stringContaining('Quero comprar') }])
})

it('sem a preferência ligada ninguém é avisado', async () => {
  await bindings.DB.prepare("UPDATE conversations SET assignee_id='member-a2' WHERE id='inbox-cc-a'").run()
  await settings('member-a2', { assignedMessage: 0, chat: '777' })
  await inbound()
  await drainMemberAlerts(prod)
  expect(await emails()).toEqual([]); expect(telegram).toEqual([])
})

it('nova conversa sem responsável avisa quem pediu, no máximo uma vez por intervalo, e volta a avisar depois', async () => {
  let now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  await settings('member-a2', { unassigned: 1 })
  await inbound('um', 'm1'); await inbound('dois', 'm2')
  await drainMemberAlerts(prod)
  expect(await emails()).toHaveLength(1)
  now += (ALERT_INTERVAL_MINUTES + 1) * 60_000
  await inbound('três', 'm3')
  await drainMemberAlerts(prod)
  expect(await emails()).toHaveLength(2)
})

it('atribuir a conversa avisa o novo responsável, menos quando ele mesmo se atribuiu', async () => {
  await settings('member-a2', { toMe: 1 })
  const res = await call('inbox/conversations/inbox-cc-a/assign', 'POST', { member_id: 'member-a2' })
  expect(res.status).toBe(200)
  expect(await emails()).toHaveLength(1)
  expect((await emails())[0]!.subject).toMatch(/atribu/i)
})

it('falha do e-mail não derruba o recebimento e o Telegram ainda segue', async () => {
  await bindings.DB.prepare("UPDATE conversations SET assignee_id='member-a2' WHERE id='inbox-cc-a'").run()
  await settings('member-a2', { chat: '777', assignedMessage: 1 })
  ;(bindings.EMAIL!.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fora do ar'))
  await inbound()
  await drainMemberAlerts(prod)
  expect(telegram).toHaveLength(1)
})

it('contatos de aviso e preferências: salvar, ler e recusar e-mail inválido', async () => {
  expect((await (await call('me/alerts')).json() as any).chat_bots).toEqual([{ id: 'tg-a', name: '@avisos_bot' }])
  const saved = await call('me/alerts', 'PUT', { email_enabled: true, alert_email: 'outro@exemplo.test', on_assigned_message: true, on_unassigned: false, on_assigned_to_me: true })
  expect(saved.status).toBe(200)
  expect(await (await call('me/alerts')).json()).toMatchObject({ alert_email: 'outro@exemplo.test', on_assigned_message: true, on_assigned_to_me: true, chat_linked: false, account_email: 'a@example.test' })
  expect((await call('me/alerts', 'PUT', { email_enabled: true, alert_email: 'não é e-mail', on_assigned_message: true, on_unassigned: false, on_assigned_to_me: true })).status).toBe(400)
})

it('vínculo do Telegram: link com código, /start do bot vincula o chat e responde, código vale uma vez', async () => {
  const link = await (await call('me/alerts/chat-link', 'POST', { channel_id: 'tg-a' })).json() as { url: string; code: string }
  expect(link.url).toBe(`https://t.me/avisos_bot?start=${link.code}`)
  expect(await handleAlertStart(bindings, 'a', 'tg-a', '555', `/start ${link.code}`)).toBe(true)
  expect(telegram).toEqual([{ chat: '555', text: expect.stringContaining('vinculado') }])
  expect(await (await call('me/alerts')).json()).toMatchObject({ chat_linked: true })
  expect(await handleAlertStart(bindings, 'a', 'tg-a', '666', `/start ${link.code}`)).toBe(true)
  expect(await bindings.DB.prepare("SELECT chat_id FROM member_alert_settings WHERE member_id='member-a'").first('chat_id')).toBe('555')
  expect((await call('me/alerts/chat', 'DELETE')).status).toBe(204)
  expect(await (await call('me/alerts')).json()).toMatchObject({ chat_linked: false })
})

it('/start de código desconhecido ou texto comum não é vínculo', async () => {
  expect(await handleAlertStart(bindings, 'a', 'tg-a', '5', '/start al000000000000')).toBe(false)
  expect(await handleAlertStart(bindings, 'a', 'tg-a', '5', 'oi')).toBe(false)
})

it('ação Notificar responsáveis entrega por e-mail e Telegram só pelos meios marcados, e o aviso do painel segue', async () => {
  await settings('member-a2', { chat: '777' })
  const run = { id: 'r1', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', automation_id: 'auto-a' } as Run
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v1','a','auto-a',1,'{}')"),
    bindings.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,channel_id,automation_version_id) VALUES ('r1','a','c-a','ch-a','v1')"),
  ])
  const runtime = bindings as unknown as FlowEnv
  await actions(runtime, run, { actions: [{ type: 'notify_admin', message: 'Cliente pediu humano', recipient_id: 'member-a2', via: ['email', 'chat'] }] }, 1)
  await drainMemberAlerts(prod)
  expect(await emails()).toEqual([expect.objectContaining({ to: 'bruno@example.test', text: expect.stringContaining('Cliente pediu humano') })])
  expect(telegram).toHaveLength(1)
  expect(await bindings.DB.prepare('SELECT count(*) AS n FROM team_notifications').first('n')).toBe(1)
  await actions(runtime, run, { actions: [{ type: 'notify_admin', message: 'Só painel', recipient_id: 'member-a2' }] }, 2)
  await drainMemberAlerts(prod)
  expect(await emails()).toHaveLength(1)
})
