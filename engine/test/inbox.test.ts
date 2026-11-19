import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/env'
import { ensureConversation, isAutomationPaused, recordMessage, type Conversation, type Message } from '../src/inbox/service'
import { origin, seedAuth, fixtureCookie } from './auth-helpers'
import { giveCredentials } from './credentials'

const botToken = 'TESTONLY-INBOX-BOT-TOKEN'

const bindings = () => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a' } as Env)
const sockets: WebSocket[] = []

function request(path: string, init: RequestInit = {}, workspace = 'a', runtime = bindings()) {
  const headers = new Headers(init.headers)
  headers.set('x-workspace', workspace)
  if (!headers.has('origin')) headers.set('origin', origin)
  headers.set('content-type', 'application/json')
  return app.request(`${origin}/api/${path}`, { ...init, headers }, runtime)
}

function post(path: string, body?: unknown, workspace = 'a', runtime = bindings()) {
  return request(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, workspace, runtime)
}

async function connect(workspace = 'a') {
  const response = await request('inbox/live', { headers: { Upgrade: 'websocket' } }, workspace)
  expect(response.status).toBe(101)
  const socket = (response as Response & { webSocket: WebSocket }).webSocket
  socket.accept()
  sockets.push(socket)
  return socket
}

function nextFrame(socket: WebSocket, accepts: (frame: string) => boolean = () => true): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Evento WebSocket não recebido.')) }, 3000)
    const receive = (event: MessageEvent) => {
      if (!accepts(String(event.data))) return
      clearTimeout(timeout)
      socket.removeEventListener('message', receive)
      resolve(String(event.data))
    }
    socket.addEventListener('message', receive)
  })
}

async function inbound(id = crypto.randomUUID(), text = 'Olá, quero conversar') {
  return recordMessage(env, { id, workspaceId: 'a', conversationId: 'inbox-cc-a', direction: 'in', sender: 'contact', text })
}

beforeEach(async () => {
  await seedAuth()
  await env.DB.batch(['a', 'b'].map(ws => env.DB.prepare("UPDATE channels SET type='telegram' WHERE id=?").bind(`ch-${ws}`)))
  await giveCredentials(env, 'ch-a', { botToken, webhookSecret: 'inbox-secret-a' })
  await ensureConversation(env, 'a', 'c-a', 'ch-a')
  await ensureConversation(env, 'b', 'c-b', 'ch-b')
})

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close(1000)
  vi.restoreAllMocks()
})

describe('dev sem login e isolamento da Caixa de entrada', () => {
  it('descobre o workspace e aceita seu proprietário apenas no ambiente development', async () => {
    const discovery = await request('dev/workspace')
    expect(discovery.status).toBe(200)
    expect(await discovery.json()).toEqual({ workspace_id: 'a', name: 'Workspace a' })
    expect((await request('inbox/conversations')).status).toBe(200)
    expect((await request('inbox/conversations', {}, 'a', { ...bindings(), APP_ENV: 'production' })).status).toBe(403)
    expect((await request('dev/workspace', {}, 'a', { ...bindings(), APP_ENV: 'production' })).status).toBe(404)
    expect((await request('inbox/conversations', {}, 'a', { ...bindings(), DEV_AUTO_LOGIN: undefined })).status).toBe(401)
    expect((await request('inbox/conversations', {}, 'inexistente')).status).toBe(404)
    expect((await request('inbox/conversations', { headers: { origin: 'https://outro.example' } })).status).toBe(403)
  })

  it('isola listagem, histórico, resposta e mutações entre workspaces', async () => {
    const list = await (await request('inbox/conversations?status=all')).json() as { rows: Conversation[] }
    expect(list.rows.map(row => row.id)).toEqual(['inbox-cc-a'])
    expect(list.rows[0].contact).toEqual({ id: 'c-a', name: 'Mariana Oliveira', avatar_initials: 'MO' })
    expect((await request('inbox/conversations/inbox-cc-b/messages')).status).toBe(404)
    for (const [action, body] of [['messages', { text: 'Uma nota', kind: 'note' }], ['read', undefined],
      ['status', { status: 'closed' }], ['assign', { member_id: 'member-a' }]] as const) {
      expect((await post(`inbox/conversations/inbox-cc-b/${action}`, body)).status).toBe(404)
    }
    expect((await post('inbox/conversations/inbox-cc-a/assign', { member_id: 'member-b' })).status).toBe(400)
    expect(await env.DB.prepare("SELECT status FROM conversations WHERE id='inbox-cc-b'").first('status')).toBe('open')
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE workspace_id='b'").first('n')).toBe(0)
  })

  it('valida filtros, cursor, JSON e mensagens vazias sem efeitos laterais', async () => {
    expect((await request('inbox/conversations?status=desconhecido')).status).toBe(400)
    expect((await request('inbox/conversations?cursor=invalido')).status).toBe(400)
    expect((await request('inbox/conversations/inbox-cc-a/messages?before=invalido')).status).toBe(400)
    expect((await request('inbox/conversations/inbox-cc-a/messages', { method: 'POST', body: '{' })).status).toBe(400)
    expect((await post('inbox/conversations/inbox-cc-a/messages', { text: '  ', kind: 'note' })).status).toBe(400)
    expect((await post('inbox/conversations/inbox-cc-a/status', { status: 'outro' })).status).toBe(400)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first('n')).toBe(0)
  })
})

describe('paginação estável com timestamps empatados', () => {
  it('percorre 51 conversas sem repetir nem perder uma e respeita status', async () => {
    await env.DB.batch(Array.from({ length: 50 }, (_, index) => {
      const id = `page-${String(index).padStart(3, '0')}`
      return [env.DB.prepare('INSERT INTO contacts(id,workspace_id,first_name) VALUES (?,\'a\',?)').bind(id, `Pessoa ${index}`),
        env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id) VALUES (?,'a',?,'ch-a',?)").bind(id, id, id),
        env.DB.prepare("INSERT INTO conversations(id,workspace_id,contact_channel_id,last_message_at) VALUES (?,'a',?,1000)").bind(id, id)]
    }).flat())
    await env.DB.prepare("UPDATE conversations SET last_message_at=1000 WHERE workspace_id='a'").run()
    const first = await (await request('inbox/conversations?status=all')).json() as { rows: Conversation[]; next_cursor: string }
    expect(first.rows).toHaveLength(50)
    expect(first.next_cursor).toBeTruthy()
    const last = await (await request(`inbox/conversations?status=all&cursor=${encodeURIComponent(first.next_cursor)}`)).json() as { rows: Conversation[]; next_cursor: null }
    expect(last.rows).toHaveLength(1)
    expect(last.next_cursor).toBeNull()
    const ids = [...first.rows, ...last.rows].map(row => row.id)
    expect(new Set(ids).size).toBe(51)
    expect(ids).toEqual([...ids].sort().reverse())
    await post(`inbox/conversations/${ids[0]}/status`, { status: 'closed' })
    const closed = await (await request('inbox/conversations?status=closed')).json() as { rows: Conversation[] }
    expect(closed.rows.map(row => row.id)).toEqual([ids[0]])
    const open = await (await request('inbox/conversations?status=open')).json() as { rows: Conversation[] }
    expect(open.rows).toHaveLength(50)
    expect(open.rows.every(row => row.status === 'open')).toBe(true)
  })

  it('entrega as 51 mensagens em ordem cronológica, com cursor exclusivo no empate', async () => {
    await env.DB.batch(Array.from({ length: 51 }, (_, index) => env.DB.prepare(`INSERT INTO messages
      (id,workspace_id,conversation_id,direction,source,content,created_at) VALUES (?,'a','inbox-cc-a','in','contact',?,1000)`)
      .bind(`message-${String(index).padStart(3, '0')}`, JSON.stringify({ text: `Mensagem ${index}` }))))
    const first = await (await request('inbox/conversations/inbox-cc-a/messages')).json() as { rows: Message[]; next_before: string }
    expect(first.rows).toHaveLength(50)
    expect(first.rows[0].id).toBe('message-001')
    expect(first.rows.at(-1)?.id).toBe('message-050')
    const older = await (await request(`inbox/conversations/inbox-cc-a/messages?before=${encodeURIComponent(first.next_before)}`)).json() as { rows: Message[]; next_before: null }
    expect(older.rows.map(row => row.id)).toEqual(['message-000'])
    expect(older.next_before).toBeNull()
    expect(new Set([...older.rows, ...first.rows].map(row => row.id)).size).toBe(51)
  })
})

describe('notas e respostas humanas', () => {
  it('grava nota sem chamar Telegram nem pausar automação', async () => {
    const send = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('A nota não deve usar rede.'))
    const response = await post('inbox/conversations/inbox-cc-a/messages', { text: 'Observação interna', kind: 'note' })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ sender: 'note', text: 'Observação interna', direction: 'out', status: 'sent' })
    expect(send).not.toHaveBeenCalled()
    expect(await isAutomationPaused(env, 'a', 'c-a')).toBe(false)
    const history = await (await request('inbox/conversations/inbox-cc-a/messages')).json() as { rows: Message[] }
    expect(history.rows).toHaveLength(1)
    expect(history.rows[0].sender).toBe('note')
  })

  it('envia resposta via Telegram, grava confirmação, limpa não lidas e pausa por 30 minutos', async () => {
    await inbound()
    const socket = await connect()
    const received = nextFrame(socket, frame => JSON.parse(frame).message?.sender === 'human')
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: { message_id: 123 } }))
    const started = Date.now()
    const response = await post('inbox/conversations/inbox-cc-a/messages', { text: 'Posso ajudar!', kind: 'reply' }, 'a', bindings())
    expect(response.status).toBe(201)
    const message = await response.json() as Message
    expect(message).toMatchObject({ sender: 'human', direction: 'out', text: 'Posso ajudar!', status: 'sent' })
    expect(message.error).toBeUndefined()
    expect(send).toHaveBeenCalledTimes(1)
    const [url, init] = send.mock.calls[0]
    expect(url).toBe(`https://api.telegram.org/bot${botToken}/sendMessage`)
    expect(JSON.parse(String(init?.body))).toEqual({ chat_id: 'user-a', text: 'Posso ajudar!' })
    expect(await env.DB.prepare('SELECT external_message_id FROM messages WHERE id=?').bind(message.id).first('external_message_id')).toBe('telegram:ch-a:user-a:123')
    const paused = await env.DB.prepare("SELECT automation_paused_until FROM contacts WHERE id='c-a'").first<number>('automation_paused_until')
    expect(paused).toBeGreaterThanOrEqual(started + 30 * 60_000)
    expect(paused).toBeLessThanOrEqual(Date.now() + 30 * 60_000)
    expect(await isAutomationPaused(env, 'a', 'c-a')).toBe(true)
    expect(await env.DB.prepare("SELECT unread_count FROM conversations WHERE id='inbox-cc-a'").first('unread_count')).toBe(0)
    expect(JSON.parse(await received)).toMatchObject({ type: 'message', message,
      conversation: { unread_count: 0, automation_paused_until: new Date(paused!).toISOString() } })
  })

  it('troca as variáveis da resposta pelos dados do contato antes de enviar', async () => {
    await env.DB.prepare("UPDATE contacts SET first_name='Aline',last_name='Sampaio' WHERE id='c-a'").run()
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: { message_id: 124 } }))
    const response = await post('inbox/conversations/inbox-cc-a/messages', { text: 'Olá, {{first_name}}! {{primeiro_nome|amigo}} {{sobrenome}}', kind: 'reply' }, 'a', { ...bindings(), CHANNEL_LIMITER: undefined })
    expect(response.status).toBe(201)
    expect(((await response.json()) as Message).text).toBe('Olá, Aline! Aline Sampaio')
    expect(JSON.parse(String(send.mock.calls[0][1]?.body)).text).toBe('Olá, Aline! Aline Sampaio')
  })

  it('preserva falha ambígua sem reenviar nem expor token e mantém pausa humana', async () => {
    const send = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`Falha em bot${botToken}`))
    const response = await post('inbox/conversations/inbox-cc-a/messages', { text: 'Resposta sem confirmação', kind: 'reply' }, 'a', { ...bindings(), CHANNEL_LIMITER: undefined })
    expect(response.status).toBe(201)
    const message = await response.json() as Message
    expect(message.status).toBe('failed')
    expect(message.error).toContain('sem confirmação')
    expect(JSON.stringify(message)).not.toContain(botToken)
    expect(send).toHaveBeenCalledTimes(1)
    expect(await isAutomationPaused(env, 'a', 'c-a')).toBe(true)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE id=?').bind(message.id).first('n')).toBe(1)
  })

  it('rejeita resposta sem canal conectado antes de gravar ou pausar', async () => {
    await env.DB.prepare('UPDATE channels SET credentials_ciphertext=NULL WHERE id=?').bind('ch-a').run()
    const send = vi.spyOn(globalThis, 'fetch')
    const response = await post('inbox/conversations/inbox-cc-a/messages', { text: 'Olá', kind: 'reply' })
    expect(response.status).toBe(409)
    expect(send).not.toHaveBeenCalled()
    expect(await isAutomationPaused(env, 'a', 'c-a')).toBe(false)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first('n')).toBe(0)
  })
})

describe('InboxHub real com WebSocket e Hibernation API', () => {
  it('publica entrada persistida com DTO completo, deduplica não lidas e isola o outro workspace', async () => {
    const a = await connect('a'), b = await connect('b')
    const otherFrames: string[] = []
    b.addEventListener('message', event => { otherFrames.push(String(event.data)) })
    const received = nextFrame(a)
    const stored = await inbound('inbound-stable', 'Mensagem recebida ao vivo')
    const event = JSON.parse(await received)
    expect(event).toMatchObject({ type: 'message', message: stored, conversation: {
      id: 'inbox-cc-a', unread_count: 1, channel_type: 'telegram', status: 'open',
      last_message: { text: 'Mensagem recebida ao vivo', direction: 'in' },
    } })
    expect(event.message.created_at).toBe(new Date(event.message.created_at).toISOString())
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE id=?').bind(stored.id).first('n')).toBe(1)
    await inbound('inbound-stable', 'Replay não substitui o texto')
    expect(await env.DB.prepare("SELECT unread_count FROM conversations WHERE id='inbox-cc-a'").first('unread_count')).toBe(1)
    const pong = nextFrame(b)
    b.send('ping')
    expect(await pong).toBe('pong')
    expect(otherFrames).toEqual(['pong'])
  })

  it('publica read/status/assign como eventos conversation e nota como message', async () => {
    await inbound()
    const socket = await connect()
    for (const [action, body, expected] of [['read', undefined, { unread_count: 0 }],
      ['unread', undefined, { unread_count: 1 }],
      ['status', { status: 'closed' }, { status: 'closed' }],
      ['assign', { member_id: 'member-a' }, { assignee_id: 'member-a' }],
      ['assign', { member_id: null }, { assignee_id: null }]] as const) {
      const received = nextFrame(socket, frame => JSON.parse(frame).type === 'conversation')
      expect((await post(`inbox/conversations/inbox-cc-a/${action}`, body)).status).toBe(200)
      expect(JSON.parse(await received)).toMatchObject({ type: 'conversation', conversation: { id: 'inbox-cc-a', ...expected } })
    }
    const received = nextFrame(socket)
    expect((await post('inbox/conversations/inbox-cc-a/messages', { kind: 'note', text: 'Nota ao vivo' })).status).toBe(201)
    expect(JSON.parse(await received)).toMatchObject({ type: 'message', message: { sender: 'note', text: 'Nota ao vivo' } })
  })

  it('a prévia da lista ignora notas internas e mostra a última mensagem trocada com o contato', async () => {
    await inbound(crypto.randomUUID(), 'Preciso de ajuda')
    expect((await post('inbox/conversations/inbox-cc-a/messages', { kind: 'note', text: 'Cliente prefere contato à tarde.' })).status).toBe(201)
    const list = await (await request('inbox/conversations')).json() as { rows: Conversation[] }
    expect(list.rows.find(row => row.id === 'inbox-cc-a')?.last_message.text).toBe('Preciso de ajuda')
  })

  it('"Rodar automação" lista só as automações do canal da conversa (e as sem canal definido)', async () => {
    await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state) VALUES ('ig-a','a','instagram','instagram_unified','ig-ext-a','connected')").run()
    const live = (id: string, name: string) => [
      env.DB.prepare("INSERT INTO automations(id,workspace_id,name,status) VALUES (?,'a',?,'live')").bind(id, name),
      env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES (?,'a',?,1,'{}')").bind(`v-${id}`, id),
      env.DB.prepare("UPDATE automations SET published_version_id=? WHERE id=?").bind(`v-${id}`, id)]
    await env.DB.batch([...live('run-tg', 'Do Telegram'), ...live('run-ig', 'Do Instagram'), ...live('run-livre', 'Sem gatilho')])
    await env.DB.batch([
      env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status) VALUES ('t-tg','a','run-tg','ch-a','Tg','welcome_message','active')"),
      env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status) VALUES ('t-ig','a','run-ig','ig-a','Ig','welcome_message','active')")])
    const names = async (query: string) => ((await (await request(`inbox/runnable-automations${query}`)).json()) as { name: string }[]).map(row => row.name)
    expect(await names('?conversation_id=inbox-cc-a')).toEqual(['Do Telegram', 'Sem gatilho'])
    expect(await names('')).toEqual(['Do Instagram', 'Do Telegram', 'Sem gatilho'])
  })

  it('exige upgrade e rejeita origem externa antes de abrir socket', async () => {
    expect((await request('inbox/live')).status).toBe(426)
    expect((await request('inbox/live', { headers: { Upgrade: 'websocket', origin: 'https://outro.example' } })).status).toBe(403)
  })
})


describe('equipe e preferências da Caixa de entrada', () => {
  it('persiste respostas salvas e isola leitura, alteração e exclusão por workspace', async () => {
    const created = await post('inbox/saved-replies', { shortcut: 'ajuda', body: 'Como posso ajudar?' })
    expect(created.status).toBe(201)
    const reply = await created.json() as { id: string }
    expect(await (await request('inbox/saved-replies')).json()).toEqual([expect.objectContaining({ id: reply.id, shortcut: 'ajuda' })])
    expect(await (await request('inbox/saved-replies', {}, 'b')).json()).toEqual([])
    expect((await request(`inbox/saved-replies/${reply.id}`, { method: 'PUT', body: JSON.stringify({ shortcut: 'ajuda', body: 'Alterada' }) }, 'b')).status).toBe(404)
    expect((await request(`inbox/saved-replies/${reply.id}`, { method: 'DELETE' }, 'b')).status).toBe(404)
    expect((await request(`inbox/saved-replies/${reply.id}`, { method: 'PUT', body: JSON.stringify({ shortcut: 'ajuda', body: 'Atualizada' }) })).status).toBe(200)
    expect((await request(`inbox/saved-replies/${reply.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await (await request('inbox/saved-replies')).json()).toEqual([])
  })

  it('nota mencionada avisa só o membro correto e a leitura é persistente', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sem rede em notas'))
    expect((await post('inbox/conversations/inbox-cc-a/messages', { kind: 'note', text: '@Pessoa a pode ajudar?', mention_member_ids: ['member-b'] })).status).toBe(400)
    expect(await env.DB.prepare('SELECT count(*) AS n FROM messages').first('n')).toBe(0)
    const socket = await connect()
    const notice = nextFrame(socket, frame => JSON.parse(frame).message?.sender === 'note')
    expect((await post('inbox/conversations/inbox-cc-a/messages', { kind: 'note', text: '@Pessoa a pode ajudar?', mention_member_ids: ['member-a', 'member-a'] })).status).toBe(201)
    await notice
    const mentions = await (await request('inbox/mentions')).json() as { id: string; text: string }[]
    expect(mentions).toHaveLength(1)
    expect(mentions[0].text).toBe('@Pessoa a pode ajudar?')
    expect(await (await request('inbox/mentions', {}, 'b')).json()).toEqual([])
    expect((await post(`inbox/mentions/${mentions[0].id}/read`, {}, 'b')).status).toBe(404)
    expect((await post(`inbox/mentions/${mentions[0].id}/read`, {})).status).toBe(200)
    expect(await (await request('inbox/mentions')).json()).toEqual([])
    expect(network).not.toHaveBeenCalled()
  })

  it('identifica o membro atual, conta abertas e retorna os membros com assento', async () => {
    await post('inbox/conversations/inbox-cc-a/assign', { member_id: 'member-a' })
    const context = await (await request('inbox/context')).json()
    expect(context).toMatchObject({ current_member_id: 'member-a', can_configure: true, counts: { open: 1, mine: 1, mentions: 0 }, members: [{ id: 'member-a', name: 'Pessoa a' }] })
    await post('inbox/conversations/inbox-cc-a/status', { status: 'closed' })
    expect(await (await request('inbox/context')).json()).toMatchObject({ counts: { open: 0, mine: 0 } })
  })

  it('respeita abertura explícita, reabertura automática e duração de pausa configurada', async () => {
    const save = (body: unknown) => request('inbox/settings', { method: 'PUT', body: JSON.stringify(body) })
    expect((await save({ pause_minutes: -1, new_message_behavior: 'explicit' })).status).toBe(400)
    expect((await save({ pause_minutes: 7, new_message_behavior: 'explicit' })).status).toBe(200)
    expect(await (await request('inbox/settings')).json()).toMatchObject({ pause_minutes: 7, new_message_behavior: 'explicit' })
    expect(await (await request('inbox/settings', {}, 'b')).json()).toMatchObject({ pause_minutes: 30, new_message_behavior: 'any_message' })
    await post('inbox/conversations/inbox-cc-a/status', { status: 'closed' })
    await inbound('explicit-msg')
    expect(await env.DB.prepare("SELECT status FROM conversations WHERE id='inbox-cc-a'").first('status')).toBe('closed')
    await save({ pause_minutes: 7, new_message_behavior: 'any_message' })
    await inbound('reopen-msg')
    expect(await env.DB.prepare("SELECT status FROM conversations WHERE id='inbox-cc-a'").first('status')).toBe('open')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: { message_id: 456 } }))
    const start = Date.now()
    expect((await post('inbox/conversations/inbox-cc-a/messages', { kind: 'reply', text: 'Atendimento' }, 'a', { ...bindings(), CHANNEL_LIMITER: undefined })).status).toBe(201)
    const until = await env.DB.prepare("SELECT automation_paused_until FROM contacts WHERE id='c-a'").first<number>('automation_paused_until')
    expect(until).toBeGreaterThanOrEqual(start + 7 * 60_000)
    expect(until).toBeLessThanOrEqual(Date.now() + 7 * 60_000)
    expect(await isAutomationPaused(env, 'a', 'c-a')).toBe(true)
    await env.DB.prepare("UPDATE contacts SET automation_paused_until=? WHERE id='c-a'").bind(start - 1).run()
    expect(await isAutomationPaused(env, 'a', 'c-a')).toBe(false)
  })
})


it('menção entre colegas é privada e agente consulta respostas sem editar preferências', async () => {
  await env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role,inbox_seat) VALUES ('agent-a','a','user-b','livechat_agent',1)").run()
  const cookie = await fixtureCookie('b')
  const agent = (path: string, init: RequestInit = {}) => request(path, { ...init, headers: { cookie } }, 'a', { ...bindings(), DEV_AUTO_LOGIN: undefined })
  expect((await post('inbox/conversations/inbox-cc-a/messages', { kind: 'note', text: '@Pessoa b revisar', mention_member_ids: ['agent-a'] })).status).toBe(201)
  expect(await (await request('inbox/mentions')).json()).toEqual([])
  const notices = await (await agent('inbox/mentions')).json() as { id: string }[]
  expect(notices).toHaveLength(1)
  expect((await post(`inbox/mentions/${notices[0].id}/read`, {})).status).toBe(404)
  expect((await agent(`inbox/mentions/${notices[0].id}/read`, { method: 'POST', body: '{}' })).status).toBe(200)
  expect((await agent('inbox/saved-replies')).status).toBe(200)
  expect((await agent('inbox/saved-replies', { method: 'POST', body: JSON.stringify({ shortcut: 'teste', body: 'Texto' }) })).status).toBe(403)
  expect((await agent('inbox/settings', { method: 'PUT', body: JSON.stringify({ pause_minutes: 7, new_message_behavior: 'explicit' }) })).status).toBe(403)
  expect(await (await agent('inbox/context')).json()).toMatchObject({ current_member_id: 'agent-a', can_configure: false })
})

it('conversa nova nasce fechada no modo explícito e janela segue sobrescrita da conexão', async () => {
  await request('inbox/settings', { method: 'PUT', body: JSON.stringify({ pause_minutes: 30, new_message_behavior: 'explicit' }) })
  await env.DB.prepare("DELETE FROM conversations WHERE workspace_id='a'").run()
  await ensureConversation(env, 'a', 'c-a', 'ch-a')
  const rows = async () => (await (await request('inbox/conversations?status=all')).json() as { rows: (Conversation & { reply_policy: { can_reply: boolean } })[] }).rows
  expect((await rows())[0].status).toBe('closed')
  await env.DB.prepare('UPDATE channels SET capabilities_override=? WHERE id=?').bind(JSON.stringify({ window: { standardHours: 24, outside: 'template' } }), 'ch-a').run()
  await env.DB.prepare("UPDATE contact_channels SET window_expires_at=1 WHERE id='cc-a'").run()
  expect((await rows())[0].reply_policy.can_reply).toBe(false)
  await env.DB.prepare('UPDATE channels SET capabilities_override=? WHERE id=?').bind(JSON.stringify({ remove: ['window'] }), 'ch-a').run()
  expect((await rows())[0].reply_policy.can_reply).toBe(true)
})

it('composer e envio compartilham a conexão mais recente do contato', async () => {
  await env.DB.prepare('UPDATE channels SET capabilities_override=? WHERE id=?').bind(JSON.stringify({ window: { standardHours: 24, outside: 'template' } }), 'ch-a').run()
  await env.DB.prepare("UPDATE contact_channels SET window_expires_at=1,last_inbound_at=100 WHERE id='cc-a'").run()
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,status) VALUES ('ch-latest','a','telegram','telegram_bot','latest','connected')").run()
  await env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,last_inbound_at,opted_in) VALUES ('cc-latest','a','c-a','ch-latest','user-latest',200,1)").run()
  const policy = async () => {
    const list = await (await request('inbox/conversations?status=all')).json() as { rows: Conversation[] }
    return list.rows.find(row => row.id === 'inbox-cc-a')?.reply_policy
  }
  expect(await policy()).toEqual({ can_reply: true, expires_at: null })
  await env.DB.prepare("UPDATE contact_channels SET last_inbound_at=300 WHERE id='cc-a'").run()
  expect(await policy()).toEqual({ can_reply: false, expires_at: '1970-01-01T00:00:00.001Z' })
})


it('composer permite a resposta humana sem janela após descadastro, como o envio', async () => {
  await env.DB.prepare("UPDATE contact_channels SET opted_in=0 WHERE id='cc-a'").run()
  const list = await (await request('inbox/conversations?status=all')).json() as { rows: Conversation[] }
  expect(list.rows[0].reply_policy.can_reply).toBe(true)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: { message_id: 789 } }))
  const response = await post('inbox/conversations/inbox-cc-a/messages', { kind: 'reply', text: 'Atendimento solicitado' }, 'a', { ...bindings(), CHANNEL_LIMITER: undefined })
  expect(response.status).toBe(201)
})

it.each([
  ['instagram', 'instagram_unified', { accessToken: 'TESTONLY', accountId: '123' }],
  ['messenger', 'messenger_page', { accessToken: 'TESTONLY', pageId: '123' }],
] as const)('resposta humana usa extensão da ficha e etiqueta, sem ultrapassar o prazo (%s)', async (kind, provider, credentials) => {
  await env.DB.prepare('UPDATE channels SET type=?,provider=? WHERE id=?').bind(kind, provider, 'ch-a').run()
  await giveCredentials(env, 'ch-a', credentials)
  const now = Date.now()
  await env.DB.prepare("UPDATE contact_channels SET external_user_id='456',last_inbound_at=?,window_expires_at=?,human_window_expires_at=? WHERE id='cc-a'")
    .bind(now - 48 * 3600_000, now - 24 * 3600_000, now + 5 * 86400_000).run()
  const policy = async () => (await (await request('inbox/conversations?status=all')).json() as { rows: Conversation[] }).rows[0].reply_policy
  expect(await policy()).toMatchObject({ can_reply: true, mode: 'human_agent' })
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ message_id: 'fake-human', recipient_id: '456' }))
  const response = await post('inbox/conversations/inbox-cc-a/messages', { kind: 'reply', text: 'Seguimos com seu atendimento.' }, 'a', { ...bindings(), CHANNEL_LIMITER: undefined })
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({ sender: 'human', status: 'sent' })
  expect(send).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(send.mock.calls[0][1]?.body))).toMatchObject({ tag: 'HUMAN_AGENT', ...(kind === 'messenger' ? { messaging_type: 'MESSAGE_TAG' } : {}) })
  await env.DB.prepare("UPDATE contact_channels SET human_window_expires_at=? WHERE id='cc-a'").bind(now - 1).run()
  expect(await policy()).toMatchObject({ can_reply: false })
  expect((await post('inbox/conversations/inbox-cc-a/messages', { kind: 'reply', text: 'Fora do prazo' })).status).toBe(409)
  expect(send).toHaveBeenCalledTimes(1)
})

it('envia só modelo aprovado da conexão efetiva, com variáveis, fora da janela', async () => {
  await env.DB.prepare("DELETE FROM conversations WHERE id='inbox-cc-a'").run()
  await env.DB.prepare("DELETE FROM contact_channels WHERE id='cc-a'").run()
  await env.DB.prepare("UPDATE channels SET type='whatsapp',provider='meta_whatsapp_cloud' WHERE id='ch-a'").run()
  await env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,window_expires_at,opted_in) VALUES ('cc-a','a','c-a','ch-a','BR.testonly','bsuid',1,1)").run()
  await ensureConversation(env, 'a', 'c-a', 'ch-a')
  await giveCredentials(env, 'ch-a', { accessToken: 'TESTONLY', phoneNumberId: '123' })
  await env.DB.prepare(`INSERT INTO message_templates(id,workspace_id,channel_id,group_id,name_human,language_code,body,status)
    VALUES ('approved','a','ch-a','group-approved','retorno','pt_BR','Olá {{1}}, seu pedido está pronto.','approved')`).run()
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'fake-template' }] }))
  expect((await post('inbox/conversations/inbox-cc-a/messages', { kind: 'reply', text: 'Texto livre' })).status).toBe(409)
  for (const template of [{ id: 'approved', params: {} }, { id: 'inexistente', params: { '1': 'Nara' } }]) {
    const response = await post('inbox/conversations/inbox-cc-a/messages', { kind: 'template', template })
    expect(response.ok).toBe(false)
  }
  expect(send).not.toHaveBeenCalled()
  const response = await post('inbox/conversations/inbox-cc-a/messages', { kind: 'template', template: { id: 'approved', params: { '1': 'Nara' } } }, 'a', { ...bindings(), CHANNEL_LIMITER: undefined })
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({ sender: 'human', text: 'Olá Nara, seu pedido está pronto.', status: 'sent' })
  expect(JSON.parse(String(send.mock.calls[0][1]?.body))).toMatchObject({ type: 'template', template: { name: 'retorno', language: { code: 'pt_BR' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Nara' }] }] } })
  const list = await (await request('inbox/conversations?status=all')).json() as { rows: Conversation[] }
  expect(list.rows[0].reply_policy).toMatchObject({ can_reply: false, template_connection_id: 'ch-a' })
  await env.DB.prepare("UPDATE message_templates SET status='paused' WHERE id='approved'").run()
  expect((await post('inbox/conversations/inbox-cc-a/messages', { kind: 'template', template: { id: 'approved', params: { '1': 'Nara' } } })).status).toBe(404)
  expect(send).toHaveBeenCalledTimes(1)
  await env.DB.prepare("UPDATE message_templates SET status='approved' WHERE id='approved'").run()
  await env.DB.prepare("UPDATE contact_channels SET opted_in=0 WHERE id='cc-a'").run()
  expect((await post('inbox/conversations/inbox-cc-a/messages', { kind: 'template', template: { id: 'approved', params: { '1': 'Nara' } } })).status).toBe(409)
  expect(send).toHaveBeenCalledTimes(1)
})

describe('filtro personalizado da Caixa de entrada', () => {
  it('filtra conversas pelas condições do contato e recusa filtro inválido', async () => {
    await inbound()
    const list = async (rules: unknown[]) => {
      const response = await request(`inbox/conversations?status=all&contact_filter=${encodeURIComponent(JSON.stringify({ match: 'all', rules }))}`)
      expect(response.status).toBe(200)
      return ((await response.json()) as { rows: Conversation[] }).rows.map(row => row.id)
    }
    expect(await list([{ type: 'tag', tag_id: 'tag-a', operator: 'has' }])).toEqual(['inbox-cc-a'])
    expect(await list([{ type: 'tag', tag_id: 'tag-a', operator: 'not_has' }])).toEqual([])
    expect((await request('inbox/conversations?contact_filter=%7Bquebrado')).status).toBe(400)
  })
})

describe('lembrete da conversa', () => {
  it('marca, mostra na conversa e no horário reabre com aviso no histórico', async () => {
    await inbound()
    const { fireDueReminders } = await import('../src/inbox/service')
    const at = new Date(Date.now() + 3600_000).toISOString()
    const set = await request('inbox/conversations/inbox-cc-a/reminder', { method: 'POST', body: JSON.stringify({ at, note: 'Retornar com o orçamento' }) })
    expect(set.status).toBe(200)
    expect(await set.json()).toMatchObject({ reminder_at: at, reminder_note: 'Retornar com o orçamento' })
    expect((await request('inbox/conversations/inbox-cc-a/reminder', { method: 'POST', body: JSON.stringify({ at: new Date(Date.now() - 1000).toISOString() }) })).status).toBe(400)
    await env.DB.prepare("UPDATE conversations SET status='closed',unread=0,unread_count=0 WHERE id='inbox-cc-a'").run()
    expect(await fireDueReminders(env, Date.now() + 2 * 3600_000)).toBe(1)
    const row = await env.DB.prepare("SELECT status,unread,reminder_at FROM conversations WHERE id='inbox-cc-a'").first()
    expect(row).toMatchObject({ status: 'open', unread: 1, reminder_at: null })
    const messages = await (await request('inbox/conversations/inbox-cc-a/messages')).json() as { rows: Message[] }
    expect(messages.rows.at(-1)).toMatchObject({ sender: 'system', text: 'Lembrete: Retornar com o orçamento' })
  })
})

describe('abrir conversa pelo perfil', () => {
  it('devolve a conversa do contato e recusa contato sem conexão', async () => {
    const opened = await request('inbox/contacts/c-a/conversation', { method: 'POST', body: '{}' })
    expect(opened.status).toBe(200)
    expect(await opened.json()).toEqual({ id: 'inbox-cc-a' })
    await env.DB.prepare("DELETE FROM contact_channels WHERE contact_id='c-a'").run()
    expect((await request('inbox/contacts/c-a/conversation', { method: 'POST', body: '{}' })).status).toBe(409)
  })
})

describe('rodar automação pelo chat', () => {
  it('cria a execução para o contato da conversa só com automação publicada', async () => {
    const run = (automation_id: string) => request('inbox/conversations/inbox-cc-a/run-automation', { method: 'POST', body: JSON.stringify({ automation_id }) })
    expect((await run('auto-a')).status).toBe(409)
    const { publishAutomation } = await import('../src/db/automations')
    await publishAutomation(env.DB, 'a', 'auto-a')
    await env.DB.prepare("UPDATE automations SET status='live' WHERE id='auto-a'").run()
    expect((await run('auto-a')).status).toBe(201)
    expect(await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE contact_id='c-a' AND id LIKE 'inbox-%'").first('n')).toBe(1)
    // A origem no histórico é a equipe, não o passo "iniciar outra automação".
    const { rows } = await (await request('inbox/conversations/inbox-cc-a/messages')).json() as { rows: { event?: { kind: string; trigger_kind?: string } }[] }
    expect(rows.find(m => m.event?.kind === 'trigger')?.event?.trigger_kind).toBe('manual')
  })
})

describe('mensagem agendada no chat', () => {
  it('agenda, lista, sai no horário pela resposta humana e só o autor ou admin cancela', async () => {
    await inbound()
    const { sendDueScheduledMessages } = await import('../src/inbox/routes')
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: { message_id: 321 } }))
    const at = new Date(Date.now() + 3600_000).toISOString()
    expect((await request('inbox/conversations/inbox-cc-a/scheduled', { method: 'POST', body: JSON.stringify({ text: 'Bom dia!', send_at: new Date(Date.now() - 1000).toISOString() }) })).status).toBe(400)
    const created = await request('inbox/conversations/inbox-cc-a/scheduled', { method: 'POST', body: JSON.stringify({ text: 'Bom dia!', send_at: at }) })
    expect(created.status).toBe(201)
    const list = await (await request('inbox/conversations/inbox-cc-a/scheduled')).json() as { status: string; mine: boolean }[]
    expect(list).toEqual([expect.objectContaining({ status: 'scheduled', mine: true })])
    const isolated = { ...env, CHANNEL_LIMITER: undefined } as never
    expect(await sendDueScheduledMessages(isolated, Date.now() + 2 * 3600_000)).toBe(1)
    expect(await env.DB.prepare("SELECT status,error FROM inbox_scheduled_messages").first()).toEqual({ status: 'sent', error: null })
    expect(send).toHaveBeenCalled()
    expect(await sendDueScheduledMessages(isolated, Date.now() + 2 * 3600_000)).toBe(0)
    const second = await (await request('inbox/conversations/inbox-cc-a/scheduled', { method: 'POST', body: JSON.stringify({ text: 'Outra', send_at: at }) })).json() as { id: string }
    await env.DB.prepare("UPDATE inbox_scheduled_messages SET created_by='outra-pessoa' WHERE id=?").bind(second.id).run()
    // Dono cancela o agendamento de outra pessoa; o autor também (o resto da equipe recebe 403).
    expect((await request(`inbox/conversations/inbox-cc-a/scheduled/${second.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await env.DB.prepare('SELECT status FROM inbox_scheduled_messages WHERE id=?').bind(second.id).first('status')).toBe('cancelled')
  })
})

describe('etiquetas da caixa de entrada', () => {
  it('manual põe e tira; automática marca quando o contato casa a condição ao chegar mensagem', async () => {
    const manual = await (await request('inbox/labels', { method: 'POST', body: JSON.stringify({ name: 'Urgente', color: 'danger' }) })).json() as { id: string }
    const auto = await (await request('inbox/labels', { method: 'POST', body: JSON.stringify({ name: 'Lead', condition: { match: 'all', rules: [{ type: 'tag', tag_id: 'tag-a', operator: 'has' }] } }) })).json() as { id: string }
    const on = await request('inbox/conversations/inbox-cc-a/labels', { method: 'POST', body: JSON.stringify({ label_id: manual.id, on: true }) })
    expect((await on.json() as Conversation).labels.map(l => l.name)).toEqual(['Urgente'])
    await inbound()
    const list = await (await request('inbox/conversations?status=all')).json() as { rows: Conversation[] }
    expect(list.rows.find(r => r.id === 'inbox-cc-a')?.labels.map(l => l.name)).toEqual(['Lead', 'Urgente'])
    const off = await request('inbox/conversations/inbox-cc-a/labels', { method: 'POST', body: JSON.stringify({ label_id: manual.id, on: false }) })
    expect((await off.json() as Conversation).labels.map(l => l.id)).toEqual([auto.id])
    expect((await request('inbox/labels', { method: 'POST', body: JSON.stringify({ name: 'Lead' }) })).status).toBe(409)
  })
})
