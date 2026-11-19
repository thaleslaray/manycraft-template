import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import { D1_TRACE_HEADER, D1_TRACE_RESULT_HEADER } from '../src/d1-trace'
import { fixtureCookie, origin, seedAuth } from './auth-helpers'
import { d1ComAtraso } from './d1-atraso'

beforeEach(seedAuth)

async function idas(path: string, headers: Record<string, string>) {
  const response = await app.request(`${origin}${path}`, { headers: { [D1_TRACE_HEADER]: '1', ...headers } }, env)
  const [total, emFila] = (response.headers.get(D1_TRACE_RESULT_HEADER) ?? '').split(',').map(Number)
  return { status: response.status, total, emFila }
}

it('o rastreio só liga com o header e em desenvolvimento', async () => {
  const cookie = await fixtureCookie('a')
  const sem = await app.request(`${origin}/api/session/workspace`, { headers: { cookie } }, env)
  expect(sem.headers.get(D1_TRACE_RESULT_HEADER)).toBeNull()
  const prod = await app.request(`${origin}/api/session/workspace`, { headers: { cookie, [D1_TRACE_HEADER]: '1' } }, { ...env, APP_ENV: 'production' as const })
  expect(prod.headers.get(D1_TRACE_RESULT_HEADER)).toBeNull()
  expect((await idas('/api/session/workspace', { cookie })).total).toBeGreaterThan(0)
})

it('idas ao D1 por rota autenticada sem o cache da sessão', async () => {
  const cookie = await fixtureCookie('a')
  const rotas = {
    'get-session': await idas('/api/auth/get-session', { cookie }),
    'session/workspace': await idas('/api/session/workspace', { cookie }),
    'automations (lista)': await idas('/api/automations', { cookie, 'x-workspace': 'a' }),
  }
  // Antes (validação de schema por pedido + sessão e usuário em fila): 5, 6 e 9 idas. A lista de automações era 5 (sessão, membro e
  // três ondas); agora a lista inteira vai num batch só: sessão + membro + 1.
  expect(rotas['get-session']).toMatchObject({ status: 200, total: 1 })
  expect(rotas['session/workspace']).toMatchObject({ status: 200, total: 2 })
  expect(rotas['automations (lista)']).toMatchObject({ status: 200, total: 3 })
})

/** Cookie do navegador depois de um get-session: o token da sessão mais o cache `session_data`. */
async function cookieComCache(workspace = 'a') {
  const base = await fixtureCookie(workspace)
  const resposta = await app.request(`${origin}/api/auth/get-session`, { headers: { cookie: base } }, env)
  const dados = resposta.headers.get('set-cookie')?.match(/(__Secure-better-auth\.session_data=[^;]+)/)?.[1]
  if (!dados) throw new Error('get-session não devolveu o cache da sessão em cookie.')
  return `${base}; ${dados}`
}

it('com o cache em cookie, a sessão não vai ao D1 nas leituras comuns', async () => {
  const cookie = await cookieComCache()
  const rotas = {
    'get-session': await idas('/api/auth/get-session', { cookie }),
    'session/workspace': await idas('/api/session/workspace', { cookie }),
    'automations (lista)': await idas('/api/automations', { cookie, 'x-workspace': 'a' }),
  }
  expect(rotas['get-session']).toMatchObject({ status: 200, total: 1 })
  expect(rotas['session/workspace']).toMatchObject({ status: 200, total: 1 })
  expect(rotas['automations (lista)']).toMatchObject({ status: 200, total: 2 })
})

it('sessão encerrada: leitura comum vale até 60 s, escrita e rotas sensíveis cortam na hora', async () => {
  const cookie = await cookieComCache()
  const ler = (path: string, init: RequestInit = {}) => app.request(`${origin}${path}`, { ...init, headers: { cookie, 'x-workspace': 'a', origin, 'content-type': 'application/json', ...init.headers as object } }, env)
  expect((await ler('/api/team')).status).toBe(200)
  await env.DB.prepare('DELETE FROM session').run()   // o que "sair de todos os aparelhos" faz no banco
  // sensíveis: leem o banco
  for (const path of ['/api/team', '/api/team/invites', '/api/api-keys', '/api/connections', '/api/workspaces/mine', '/api/account/anything', '/api/email/domains', '/api/activity-log']) {
    expect(`${path} ${(await ler(path)).status}`).toBe(`${path} 401`)
  }
  expect((await ler('/api/team', { headers: { upgrade: 'websocket' } })).status).toBe(401)
  expect((await ler('/api/automations', { method: 'POST', body: JSON.stringify({ name: 'x' }) })).status).toBe(401)
  expect((await ler('/api/automations/x', { method: 'DELETE' })).status).toBe(401)
  // leitura comum: o atraso documentado (até 60 s)
  expect((await ler('/api/automations')).status).toBe(200)
  // passados os 60 s, o cache vence e a sessão some
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 })
  try { expect((await ler('/api/automations')).status).toBe(401) } finally { vi.useRealTimers() }
})

it('sem o token da sessão o cache sozinho não vale', async () => {
  const cookie = await cookieComCache()
  const soDados = cookie.split('; ').filter(parte => parte.includes('session_data')).join('; ')
  const resposta = await app.request(`${origin}/api/automations`, { headers: { cookie: soDados, 'x-workspace': 'a' } }, env)
  expect(resposta.status).toBe(401)
})

it('remover o membro corta a leitura comum na hora, mesmo com o cache da sessão', async () => {
  const cookie = await cookieComCache()
  await env.DB.prepare("DELETE FROM workspace_members WHERE user_id='user-a'").run()
  expect((await app.request(`${origin}/api/automations`, { headers: { cookie, 'x-workspace': 'a' } }, env)).status).toBe(404)
})

it('as telas do painel recebem o cookie de cache da sessão, sem passar pelo get-session', async () => {
  const base = await fixtureCookie('a')
  const primeira = await app.request(`${origin}/api/session/workspace`, { headers: { cookie: base } }, env)
  expect(primeira.status).toBe(200)
  const dados = primeira.headers.get('set-cookie')?.match(/(__Secure-better-auth\.session_data=[^;]+)/)?.[1]
  expect(dados).toBeTruthy()
  const seguinte = await idas('/api/automations', { cookie: `${base}; ${dados}`, 'x-workspace': 'a' })
  expect(seguinte).toMatchObject({ status: 200, total: 2 })
})

// ---- Leituras (GET) com o banco lento: o que conta é quantas idas ficam em fila ---------------------------------------
// `d1ComAtraso` põe 15 ms em cada ida, então consultas disparadas juntas se sobrepõem e as que esperam outra não. O membro
// do pedido é lido uma vez no middleware (papel e id juntos); cada rota soma uma onda (duas só com dependência real).
async function idasComAtraso(path: string, cookie: string) {
  const response = await app.request(`${origin}${path}`, { headers: { [D1_TRACE_HEADER]: '1', cookie, 'x-workspace': 'a' } }, { ...env, DB: d1ComAtraso(env.DB) })
  const [total, emFila] = (response.headers.get(D1_TRACE_RESULT_HEADER) ?? '').split(',').map(Number)
  return { status: response.status, total, emFila }
}

async function semearLeituras() {
  const batch = [
    env.DB.prepare("INSERT INTO conversations(id,workspace_id,contact_channel_id,last_message_at) VALUES ('conv-a','a','cc-a',2000)"),
    env.DB.prepare(`INSERT INTO messages(workspace_id,id,conversation_id,direction,source,content,created_at) VALUES ('a','msg-a','conv-a','in','contact','{"text":"oi"}',2000)`),
    env.DB.prepare("INSERT INTO segments(id,workspace_id,name,filter) VALUES ('seg-1','a','Com etiqueta',?),('seg-2','a','Sem etiqueta',?)")
      .bind(JSON.stringify({ match: 'all', rules: [{ type: 'tag', tag_id: 'tag-a', operator: 'has' }] }), JSON.stringify({ match: 'all', rules: [{ type: 'tag', tag_id: 'tag-a', operator: 'not_has' }] })),
    ...[1, 2, 3, 4].flatMap(n => [
      env.DB.prepare('INSERT INTO sequences(id,workspace_id,name,created_at) VALUES (?,?,?,?)').bind(`seq-${n}`, 'a', `Sequência ${n}`, n),
      env.DB.prepare("INSERT INTO sequence_steps(id,workspace_id,sequence_id,automation_id,position,delay_seconds,status) VALUES (?,?,?,'auto-a',0,60,'live'),(?,?,?,NULL,1,10,'draft')")
        .bind(`step-${n}-1`, 'a', `seq-${n}`, `step-${n}-2`, 'a', `seq-${n}`),
    ]),
  ]
  await env.DB.batch(batch)
}

it('leituras do painel: membro uma vez e consultas independentes numa onda só', async () => {
  await semearLeituras()
  const cookie = await cookieComCache()
  const rotas = {
    'inbox/context': await idasComAtraso('/api/inbox/context', cookie),
    'inbox/mentions': await idasComAtraso('/api/inbox/mentions', cookie),
    'inbox/conversations': await idasComAtraso('/api/inbox/conversations', cookie),
    'inbox/conversations/:id/messages': await idasComAtraso('/api/inbox/conversations/conv-a/messages', cookie),
    'inbox/groups': await idasComAtraso('/api/inbox/groups', cookie),
    'sequences (4 sequências)': await idasComAtraso('/api/sequences', cookie),
    'sequences/:id': await idasComAtraso('/api/sequences/seq-1', cookie),
    'segments (2 segmentos com etiqueta)': await idasComAtraso('/api/segments', cookie),
    'segments/options': await idasComAtraso('/api/segments/options', cookie),
    dashboard: await idasComAtraso('/api/dashboard', cookie),
    insights: await idasComAtraso('/api/insights', cookie),
    automations: await idasComAtraso('/api/automations', cookie),
    'automations/:id': await idasComAtraso('/api/automations/auto-a', cookie),
    'automation-library': await idasComAtraso('/api/automation-library', cookie),
    'broadcasts/options': await idasComAtraso('/api/broadcasts/options', cookie),
    'contacts/:id': await idasComAtraso('/api/contacts/c-a', cookie),
    'contacts (página + tags/campos)': await idasComAtraso('/api/contacts', cookie),
    'email/metrics': await idasComAtraso('/api/email/metrics', cookie),   // prefixo sensível: a sessão vai ao banco (3 = sessão + membro + 1)
    'automations/:id/trigger-metrics': await idasComAtraso('/api/automations/auto-a/trigger-metrics', cookie),
    'automations/:id/triggers': await idasComAtraso('/api/automations/auto-a/triggers', cookie),
    'automations/:id/stats': await idasComAtraso('/api/automations/auto-a/stats', cookie),
    // prefixo sensível (3 = sessão + membro + 1): a lista e o total de contatos de cada conexão saem na mesma onda.
    'connections (lista + total de contatos)': await idasComAtraso('/api/connections', cookie),
  }
  for (const [rota, r] of Object.entries(rotas)) expect(`${rota} ${r.status}`).toBe(`${rota} 200`)
  const filas = Object.fromEntries(Object.entries(rotas).map(([rota, r]) => [rota, r.emFila]))
  expect(filas).toEqual({
    'inbox/context': 2, 'inbox/mentions': 2, 'inbox/conversations': 3, 'inbox/conversations/:id/messages': 2, 'inbox/groups': 2,
    'sequences (4 sequências)': 2, 'sequences/:id': 2,
    'segments (2 segmentos com etiqueta)': 4, 'segments/options': 2,
    dashboard: 2, insights: 2, automations: 2, 'automations/:id': 2, 'automation-library': 2, 'broadcasts/options': 2,
    'contacts/:id': 2, 'contacts (página + tags/campos)': 3, 'email/metrics': 3, 'automations/:id/trigger-metrics': 2,
    'automations/:id/triggers': 2, 'automations/:id/stats': 2, 'connections (lista + total de contatos)': 3,
  })
  // O banco não vê mais de uma consulta por sequência: 4 sequências custam o mesmo que 1 (membro + um batch).
  expect(rotas['sequences (4 sequências)']!.total).toBe(2)
  expect(rotas['inbox/context']!.total).toBe(2)
})
