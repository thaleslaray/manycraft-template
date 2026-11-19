import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { seed, graph } from './fixtures'
import { actions } from '../src/flow/nodes'
import { listConversations } from '../src/inbox/service'
import type { FlowEnv, Run } from '../src/flow/types'
import { publishAutomation } from '../src/db/automations'
import { Hono } from 'hono'
import { team } from '../src/team'

const bindings = env as unknown as FlowEnv
const run = { id: 'actions-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', automation_id: 'auto-a' } as Run
beforeEach(async () => {
  await seed()
  bindings.FLOW_RUN = { get: vi.fn(async () => ({ terminate: vi.fn() })) } as any
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('actions-version','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    bindings.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,channel_id,automation_version_id) VALUES ('actions-run','a','c-a','ch-a','actions-version')"),
    bindings.DB.prepare("INSERT INTO workspace_members (id,workspace_id,user_id,role,inbox_seat) VALUES ('agent-a','a','person-a','livechat_agent',1),('agent-b','b','person-b','livechat_agent',1),('viewer-a','a','viewer','viewer',0)"),
    bindings.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('second-a','a','telegram','second-a')"),
    bindings.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('cc-second','a','c-a','second-a','123',1)"),
  ])
})
afterEach(() => vi.restoreAllMocks())

it('atribui e abre a conversa na caixa de entrada, fecha e permite remover atribuição', async () => {
  await actions(bindings, run, { actions: [{ type: 'assign_conversation', assignee_id: 'agent-a' }, { type: 'open_conversation' }] }, 1)
  expect((await listConversations(bindings, 'a', 'open')).rows).toEqual([expect.objectContaining({ id: 'inbox-cc-a', assignee_id: 'agent-a' })])
  await actions(bindings, run, { actions: [{ type: 'close_conversation' }, { type: 'assign_conversation', assignee_id: null }] }, 2)
  expect((await listConversations(bindings, 'a', 'closed')).rows[0]).toMatchObject({ status: 'closed', assignee_id: null })
  await actions(bindings, run, { actions: [{ type: 'open_conversation' }] }, 3)
  expect((await listConversations(bindings, 'a', 'open')).rows).toHaveLength(1)
})

it('registra notificação interna e conversão uma vez inclusive com replay do mesmo passo', async () => {
  const config = { actions: [{ type: 'notify_admin', message: 'Acompanhe este contato', recipient_id: 'agent-a' },
    { type: 'fire_custom_event', event_name: 'Pedido recebido', value: 149.9 }] }
  await actions(bindings, run, config, 1)
  await actions(bindings, run, config, 1)
  expect((await bindings.DB.prepare('SELECT recipient_id,message FROM team_notifications WHERE workspace_id=?').bind('a').all()).results)
    .toEqual([{ recipient_id: 'agent-a', message: 'Acompanhe este contato' }])
  expect((await bindings.DB.prepare('SELECT event_name,value FROM conversion_events WHERE workspace_id=?').bind('a').all()).results)
    .toEqual([{ event_name: 'Pedido recebido', value: 149.9 }])
  await actions(bindings, run, { actions: [{ type: 'notify_admin', message: 'Equipe inteira' }, { type: 'fire_custom_event', event_name: 'Sem valor' }] }, 2)
  expect(await bindings.DB.prepare('SELECT count(*) AS n FROM team_notifications WHERE recipient_id IS NULL').first('n')).toBe(1)
  expect(await bindings.DB.prepare("SELECT value FROM conversion_events WHERE event_name='Sem valor'").first('value')).toBeNull()
})

it('pausa com duração e replay conserva o primeiro prazo', async () => {
  let now = 100000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const config = { actions: [{ type: 'pause_automations', duration: { value: 2, unit: 'hours' } }] }
  await actions(bindings, run, config, 1)
  now += 30000
  await actions(bindings, run, config, 1)
  expect(await bindings.DB.prepare("SELECT automation_paused_until FROM contacts WHERE id='c-a'").first('automation_paused_until')).toBe(7300000)
})

it('retoma o aviso interno após falha no Hub sem repetir a notificação persistida', async () => {
  const notify = vi.fn().mockRejectedValueOnce(new Error('Hub indisponível')).mockResolvedValue(undefined)
  const runtime = { ...bindings, INBOX_HUB: { idFromName: (id: string) => id, get: () => ({ notify }) } } as unknown as FlowEnv
  const config = { actions: [{ type: 'notify_admin', message: 'Acompanhar' }] }
  await expect(actions(runtime, run, config, 1)).rejects.toThrow('Hub indisponível')
  expect(await bindings.DB.prepare('SELECT notified FROM team_notifications').first('notified')).toBe(0)
  await actions(runtime, run, config, 1)
  expect(await bindings.DB.prepare('SELECT count(*) AS n FROM team_notifications').first('n')).toBe(1)
  expect(await bindings.DB.prepare('SELECT notified FROM team_notifications').first('notified')).toBe(1)
  expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'team_notification' }))
})

it('liga e desliga opt-in só da conexão escolhida sem mudar a inscrição geral ou outra identidade', async () => {
  await actions(bindings, run, { actions: [{ type: 'unsubscribe_to_account', connection_id: 'second-a' }] }, 1)
  expect((await bindings.DB.prepare("SELECT channel_id,opted_in FROM contact_channels WHERE contact_id='c-a' ORDER BY channel_id").all()).results)
    .toEqual([{ channel_id: 'ch-a', opted_in: 1 }, { channel_id: 'second-a', opted_in: 0 }])
  await actions(bindings, run, { actions: [{ type: 'subscribe_to_account', connection_id: 'second-a' }] }, 2)
  await actions(bindings, run, { actions: [{ type: 'unsubscribe_to_account', connection_id: 'second-a' }] }, 1)
  expect(await bindings.DB.prepare("SELECT opted_in FROM contact_channels WHERE id='cc-second'").first('opted_in')).toBe(1)
  expect(await bindings.DB.prepare("SELECT status FROM contacts WHERE id='c-a'").first('status')).toBe('subscribed')
})

it('inscrição por tipo de canal muda só as identidades daquele canal, sem exigir conexão e sem falhar se o contato não tem o canal', async () => {
  const optedIn = async () => (await bindings.DB.prepare("SELECT channel_id,opted_in FROM contact_channels WHERE contact_id='c-a' ORDER BY channel_id").all()).results
  await actions(bindings, run, { actions: [{ type: 'set_telegram_opt_out' }, { type: 'set_tiktok_opt_in' }, { type: 'set_email_opt_out' }] }, 1)
  expect(await optedIn()).toEqual([{ channel_id: 'ch-a', opted_in: 1 }, { channel_id: 'second-a', opted_in: 0 }])
  await actions(bindings, run, { actions: [{ type: 'set_instagram_opt_out' }] }, 2)
  await actions(bindings, run, { actions: [{ type: 'set_instagram_opt_out' }] }, 2)
  expect(await optedIn()).toEqual([{ channel_id: 'ch-a', opted_in: 0 }, { channel_id: 'second-a', opted_in: 0 }])
  await actions(bindings, run, { actions: [{ type: 'set_telegram_opt_in' }, { type: 'set_instagram_opt_in' }] }, 3)
  expect(await optedIn()).toEqual([{ channel_id: 'ch-a', opted_in: 1 }, { channel_id: 'second-a', opted_in: 1 }])
  expect(await bindings.DB.prepare("SELECT opted_in FROM contact_channels WHERE contact_id='c-b'").first('opted_in')).toBe(1)
  expect(await bindings.DB.prepare("SELECT status FROM contacts WHERE id='c-a'").first('status')).toBe('subscribed')
})

it('inscrição por canal cobre WhatsApp, e-mail e TikTok e o fluxo com essas ações publica', async () => {
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('mail-a','a','email','mail-a'),('tt-a','a','tiktok','tt-a')"),
    bindings.DB.prepare("INSERT INTO channels (id,workspace_id,type,provider,external_id) VALUES ('wa-a','a','whatsapp','zapi','zapi:wa-a')"),
    bindings.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('cc-m','a','c-a','mail-a','a@x.com',1),('cc-t','a','c-a','tt-a','tt',1)"),
    bindings.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,address_kind,opted_in) VALUES ('cc-w','a','c-a','wa-a','5511999990001','provider_id','wa_pn',1)"),
  ])
  await actions(bindings, run, { actions: ['email', 'whatsapp', 'tiktok'].map(c => ({ type: `set_${c}_opt_out` })) }, 1)
  expect((await bindings.DB.prepare("SELECT id,opted_in FROM contact_channels WHERE id IN ('cc-m','cc-w','cc-t','cc-a') ORDER BY id").all()).results)
    .toEqual([{ id: 'cc-a', opted_in: 1 }, { id: 'cc-m', opted_in: 0 }, { id: 'cc-t', opted_in: 0 }, { id: 'cc-w', opted_in: 0 }])
  const node = { id: 'act', type: 'action', position: { x: 0, y: 0 }, config: { actions: [{ type: 'set_whatsapp_opt_in' }, { type: 'set_instagram_opt_out' }] } }
  await bindings.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'")
    .bind(JSON.stringify({ nodes: [graph.nodes[0], node], edges: [{ from: 't', port: 'next', to: 'act' }] })).run()
  await expect(publishAutomation(bindings.DB, 'a', 'auto-a')).resolves.toMatchObject({ automation_id: 'auto-a' })
})

it.each([
  { type: 'assign_conversation', assignee_id: 'agent-b' },
  { type: 'assign_conversation', assignee_id: 'viewer-a' },
  { type: 'notify_admin', message: 'Privado', recipient_id: 'agent-b' },
  { type: 'subscribe_to_account', connection_id: 'ch-b' },
])('bloqueia referências fora do workspace ou sem acesso: %j', async action => {
  await expect(actions(bindings, run, { actions: [{ type: 'fire_custom_event', event_name: 'Não gravar' }, action] }, 1)).rejects.toThrow()
  expect(await bindings.DB.prepare('SELECT count(*) AS n FROM timeline_action_receipts').first('n')).toBe(0)
})

it('exclui de forma idempotente, cancela runs e não executa ações depois da exclusão', async () => {
  const config = { actions: [{ type: 'delete_subscriber' }, { type: 'fire_custom_event', event_name: 'Não executar' }] }
  expect(await actions(bindings, run, config, 1)).toEqual({ deleted: true })
  expect(await actions(bindings, run, config, 1)).toEqual({ deleted: true })
  expect(await bindings.DB.prepare("SELECT status FROM contacts WHERE id='c-a'").first('status')).toBe('deleted')
  expect(await bindings.DB.prepare("SELECT status FROM flow_runs WHERE id='actions-run'").first('status')).toBe('cancelled')
  expect(await bindings.DB.prepare('SELECT count(*) AS n FROM conversion_events').first('n')).toBe(0)
  expect(await bindings.DB.prepare("SELECT count(*) AS n FROM contact_channels WHERE contact_id='c-a'").first('n')).toBe(0)
  expect(await bindings.DB.prepare("SELECT status FROM contacts WHERE id='c-b'").first('status')).toBe('subscribed')
})

it('publica fluxo só com ações e recusa parâmetros inválidos ou referências de outro workspace', async () => {
  const node = { id: 'act', type: 'action', position: { x: 0, y: 0 }, config: { actions: [{ type: 'assign_conversation', assignee_id: 'agent-a' }] } }
  const draft = { nodes: [graph.nodes[0], node], edges: [{ from: 't', port: 'next', to: 'act' }] }
  const save = async (action: unknown) => bindings.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'")
    .bind(JSON.stringify({ ...draft, nodes: [graph.nodes[0], { ...node, config: { actions: [action] } }] })).run()
  await save(node.config.actions[0])
  await expect(publishAutomation(bindings.DB, 'a', 'auto-a')).resolves.toMatchObject({ automation_id: 'auto-a' })
  for (const action of [{ type: 'pause_automations', duration: { value: -1, unit: 'hours' } },
    { type: 'pause_automations', duration: { value: 1.5, unit: 'hours' } },
    { type: 'fire_custom_event', event_name: '' }, { type: 'fire_custom_event', event_name: 'Compra', value: -1 },
    { type: 'notify_admin', message: '' }, { type: 'assign_conversation', assignee_id: 'agent-b' },
    { type: 'subscribe_to_account', connection_id: 'ch-b' }]) {
    await save(action)
    await expect(publishAutomation(bindings.DB, 'a', 'auto-a')).rejects.toThrow()
  }
})

it('editor lê responsáveis elegíveis sem acesso à gestão da equipe, e notificações respeitam destinatário', async () => {
  const api = new Hono<any>()
  api.use('*', async (c, next) => {
    c.set('principal', { workspaceId: 'a', userId: 'person-a', role: 'editor' })
    c.set('userId', 'person-a')
    c.set('memberId', 'agent-a')   // o middleware real lê o membro uma vez e guarda aqui
    await next()
  })
  api.route('/api', team)
  expect((await api.request('https://engine.test/api/team', {}, bindings)).status).toBe(403)
  const assignees = await api.request('https://engine.test/api/team/assignees', {}, bindings)
  expect(assignees.status).toBe(200)
  expect(await assignees.json()).toEqual([{ id: 'agent-a', role: 'livechat_agent' }])
  await actions(bindings, run, { actions: [{ type: 'notify_admin', message: 'Minha', recipient_id: 'agent-a' },
    { type: 'notify_admin', message: 'Equipe' }, { type: 'notify_admin', message: 'Outra pessoa', recipient_id: 'viewer-a' }] }, 1)
  const response = await api.request('https://engine.test/api/team/notifications', {}, bindings)
  expect(response.status).toBe(200)
  expect((await response.json() as any[]).map(item => item.message).sort()).toEqual(['Equipe', 'Minha'])
})
