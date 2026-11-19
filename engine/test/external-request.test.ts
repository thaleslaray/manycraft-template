import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { seed, graph } from './fixtures'
import { actions } from '../src/flow/nodes'
import { publishAutomation } from '../src/db/automations'
import { extractPath, isInternalHost, staticUrlIssue } from '../src/flow/external-url'
import type { FlowEnv, Run } from '../src/flow/types'
import { Hono } from 'hono'
import { externalRequests } from '../src/external-requests'

const bindings = env as unknown as FlowEnv
const run = { id: 'req-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', automation_id: 'auto-a' } as Run
const request = (extra: Record<string, unknown> = {}) => ({ type: 'external_request', method: 'GET', url: 'https://api.exemplo.com/cliente', headers: [], mappings: [{ path: 'data.plano', field_id: 'field-a' }], ...extra })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let server: ReturnType<typeof vi.fn>

beforeEach(async () => {
  await seed()
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('req-version','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    bindings.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,channel_id,automation_version_id) VALUES ('req-run','a','c-a','ch-a','req-version')"),
    bindings.DB.prepare("INSERT INTO custom_fields (id,workspace_id,name,type) VALUES ('field-num','a','Pedidos','number'),('field-b-only','b','Outro','text')"),
    bindings.DB.prepare("INSERT INTO workspace_members (id,workspace_id,user_id,role) VALUES ('owner-a','a','person-a','owner')"),
  ])
  server = vi.fn(async () => json({ data: { plano: 'Premium', pedidos: '7' } }))
  vi.stubGlobal('fetch', server)
})
afterEach(() => vi.unstubAllGlobals())
const field = (id: string) => bindings.DB.prepare('SELECT value FROM contact_field_values WHERE contact_id=? AND field_id=?').bind('c-a', id).first('value')
const logs = async () => (await bindings.DB.prepare('SELECT * FROM external_request_logs ORDER BY created_at').all()).results

it('resposta 200 grava os campos mapeados pelo caminho do JSON, convertendo número, e não registra erro', async () => {
  await actions(bindings, run, { actions: [request({ mappings: [{ path: 'data.plano', field_id: 'field-a' }, { path: '$.data.pedidos', field_id: 'field-num' }] })] }, 1)
  expect(await field('field-a')).toBe('"Premium"')
  expect(await field('field-num')).toBe('7')
  expect(await logs()).toEqual([])
  expect(server).toHaveBeenCalledOnce()
  const [url, init] = server.mock.calls[0] as [URL, RequestInit]
  expect(String(url)).toBe('https://api.exemplo.com/cliente')
  expect(init.redirect).toBe('manual')
  expect(init.signal).toBeInstanceOf(AbortSignal)
})

it('preenche variáveis codificadas na URL e escapadas no corpo JSON e nos cabeçalhos', async () => {
  await bindings.DB.prepare("UPDATE contacts SET first_name='Ana \"Lu\" & Cia' WHERE id='c-a'").run()
  await actions(bindings, run, { actions: [request({ method: 'POST', url: 'https://api.exemplo.com/buscar?nome={primeiro_nome}&c={{campo:field-a|sem}}',
    headers: [{ name: 'X-Nome', value: 'Ola {primeiro_nome}' }], body: '{"nome":"{primeiro_nome}","campo":"{{campo:field-a|sem}}"}', mappings: [] })] }, 1)
  const [url, init] = server.mock.calls[0] as [URL, RequestInit]
  expect(String(url)).toBe('https://api.exemplo.com/buscar?nome=Ana%20%22Lu%22%20%26%20Cia&c=Curso')
  expect(init.method).toBe('POST')
  expect(JSON.parse(init.body as string)).toEqual({ nome: 'Ana "Lu" & Cia', campo: 'Curso' })
  expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  expect(new Headers(init.headers).get('x-nome')).toBe('Ola Ana "Lu" & Cia')
})

it('{{full_contact_data}} no corpo envia o JSON completo do contato e é aceito na publicação', async () => {
  const action = request({ method: 'POST', body: '{"contato":{{full_contact_data}}}', mappings: [] })
  await actions(bindings, run, { actions: [action] }, 1)
  const [, init] = server.mock.calls[0] as [URL, RequestInit]
  expect(JSON.parse(init.body as string).contato).toMatchObject({ id: 'c-a', first_name: 'Mariana', custom_fields: expect.any(Object), tags: expect.any(Array) })
  await bindings.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(JSON.stringify({ nodes: [graph.nodes[0], { id: 'act', type: 'action', position: { x: 0, y: 0 }, config: { actions: [action] } }], edges: [{ from: 't', port: 'next', to: 'act' }] })).run()
  await expect(publishAutomation(bindings.DB, 'a', 'auto-a')).resolves.toMatchObject({ automation_id: 'auto-a' })
})

it.each([[500], [404], [201]])('resposta %i não grava campos e vai para o registro de erros', async status => {
  server.mockResolvedValue(json({ data: { plano: 'Premium' } }, status))
  await actions(bindings, run, { actions: [request()] }, 1)
  expect(await field('field-a')).toBe('"Curso"')
  expect(await logs()).toEqual([expect.objectContaining({ source: 'run', outcome: 'error', error_code: 'http_status', status, method: 'GET', target: 'api.exemplo.com/cliente', contact_id: 'c-a', automation_id: 'auto-a' })])
})

it('tempo limite, falha de rede, JSON inválido, caminho ausente e valor incompatível aparecem no registro sem derrubar o fluxo', async () => {
  const timeout = new DOMException('The operation timed out', 'TimeoutError')
  server.mockRejectedValueOnce(timeout)
  await actions(bindings, run, { actions: [request()] }, 1)
  server.mockRejectedValueOnce(new TypeError('fetch failed'))
  await actions(bindings, run, { actions: [request()] }, 2)
  server.mockResolvedValueOnce(new Response('<html>', { status: 200 }))
  await actions(bindings, run, { actions: [request()] }, 3)
  server.mockResolvedValueOnce(json({ data: {} }))
  await actions(bindings, run, { actions: [request()] }, 4)
  server.mockResolvedValueOnce(json({ data: { plano: 'x' } }))
  await actions(bindings, run, { actions: [request({ mappings: [{ path: 'data.plano', field_id: 'field-num' }] })] }, 5)
  expect((await logs()).map(row => row.error_code)).toEqual(['timeout', 'network', 'invalid_json', 'path_not_found', 'invalid_value'])
  expect(await field('field-a')).toBe('"Curso"')
  expect(await bindings.DB.prepare('SELECT count(*) AS n FROM timeline_action_receipts WHERE run_id=?').bind('req-run').first('n')).toBe(5)
})

it('mapeamento parcial grava o que casou e registra o que falhou', async () => {
  await actions(bindings, run, { actions: [request({ mappings: [{ path: 'data.plano', field_id: 'field-a' }, { path: 'data.nada', field_id: 'field-num' }] })] }, 1)
  expect(await field('field-a')).toBe('"Premium"')
  expect(await field('field-num')).toBeNull()
  expect(await logs()).toEqual([expect.objectContaining({ error_code: 'path_not_found' })])
})

it('não segue redirecionamento', async () => {
  server.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }))
  await actions(bindings, run, { actions: [request()] }, 1)
  expect(server).toHaveBeenCalledOnce()
  expect(await logs()).toEqual([expect.objectContaining({ error_code: 'redirect', status: 302 })])
})

it.each(['http://localhost/x', 'http://127.0.0.1:8787/x', 'http://10.0.0.5/x', 'http://192.168.1.1/x', 'http://169.254.169.254/latest/meta-data', 'http://172.16.0.1/', 'http://[::1]/',
  'http://0.0.0.0/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::ffff:127.0.0.1]/', 'http://intranet/', 'http://servico.internal/', 'http://[fd00::1]/'])('bloqueia endereço interno %s sem chamar a rede', async url => {
  await actions(bindings, run, { actions: [request({ url })] }, 1)
  expect(server).not.toHaveBeenCalled()
  expect(await logs()).toEqual([expect.objectContaining({ error_code: 'blocked_address', status: null })])
})

it('o apelido do provedor falso só vale em desenvolvimento e nunca libera o endereço local', async () => {
  const dev = { ...bindings, APP_ENV: 'development', DEV_PROVIDER_API_BASE: 'http://127.0.0.1:7192' } as FlowEnv
  await actions(dev, run, { actions: [request({ url: 'http://provedor-falso.test/externo/cliente?x=1' })] }, 1)
  expect(String(server.mock.calls[0][0])).toBe('http://127.0.0.1:7192/externo/cliente?x=1')
  await actions(dev, run, { actions: [request({ url: 'http://127.0.0.1:7192/externo/cliente' })] }, 2)
  expect(server).toHaveBeenCalledOnce()
  const production = { ...bindings, APP_ENV: 'production', DEV_PROVIDER_API_BASE: 'http://127.0.0.1:7192' } as FlowEnv
  await actions(production, run, { actions: [request({ url: 'http://provedor-falso.test/externo/cliente' })] }, 3)
  expect(String(server.mock.calls[1][0])).toBe('http://provedor-falso.test/externo/cliente')
})

it('repetir o mesmo passo não repete a requisição nem o registro', async () => {
  server.mockResolvedValue(json({}, 500))
  const config = { actions: [request()] }
  await actions(bindings, run, config, 1)
  await actions(bindings, run, config, 1)
  expect(server).toHaveBeenCalledOnce()
  expect(await logs()).toHaveLength(1)
})

it('a resposta grande demais é recusada', async () => {
  server.mockResolvedValue(new Response('x'.repeat(1_100_000), { status: 200 }))
  await actions(bindings, run, { actions: [request()] }, 1)
  expect(await logs()).toEqual([expect.objectContaining({ error_code: 'too_large' })])
})

it('classifica endereços e extrai caminhos', () => {
  expect(isInternalHost('api.exemplo.com')).toBe(false)
  expect(isInternalHost('8.8.8.8')).toBe(false)
  expect(isInternalHost('2001:db8::1')).toBe(false)
  expect(staticUrlIssue('https://api.exemplo.com/{{campo:x|a}}')).toBeNull()
  expect(staticUrlIssue('https://{{campo:x|a}}.com/')).toMatch(/depois do domínio/)
  expect(staticUrlIssue('https://u:p@api.exemplo.com/')).toMatch(/usuário/)
  expect(staticUrlIssue('ftp://api.exemplo.com/')).toMatch(/http/)
  expect(extractPath({ a: [{ b: 1 }, { b: 2 }] }, 'a[1].b')).toBe(2)
  expect(extractPath({ a: [{ b: 1 }] }, 'a.0.b')).toBe(1)
  expect(extractPath({ a: 1 }, 'a.b')).toBeUndefined()
  expect(extractPath({ a: 1 }, 'constructor')).toBeUndefined()
})

it('publicação recusa endereço interno, campo de outro workspace, campo repetido e variável inexistente', async () => {
  const node = (action: unknown) => ({ id: 'act', type: 'action', position: { x: 0, y: 0 }, config: { actions: [action] } })
  const publish = async (action: unknown) => {
    await bindings.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(JSON.stringify({ nodes: [graph.nodes[0], node(action)], edges: [{ from: 't', port: 'next', to: 'act' }] })).run()
    return publishAutomation(bindings.DB, 'a', 'auto-a')
  }
  await expect(publish(request())).resolves.toMatchObject({ automation_id: 'auto-a' })
  for (const bad of [request({ url: 'http://127.0.0.1/x' }), request({ mappings: [{ path: 'a', field_id: 'field-b-only' }] }),
    request({ mappings: [{ path: 'a', field_id: 'field-a' }, { path: 'b', field_id: 'field-a' }] }), request({ url: 'https://api.exemplo.com/{{campo:nao-existe|x}}' }),
    request({ method: 'TRACE' }), request({ headers: [{ name: 'Host', value: 'x' }] })]) await expect(publish(bad)).rejects.toThrow()
})

const app = new Hono<any>()
app.use('*', async (c, next) => { c.set('principal', { userId: 'u', workspaceId: 'a', role: 'owner' }); await next() })
app.route('/', externalRequests)
app.onError((error, c) => c.json({ error: error.message }, ((error as { status?: number }).status ?? 500) as 400))
const call = (path: string, body?: unknown) => app.request(path, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}, bindings)

it('o teste usa o contato escolhido, devolve resposta e mapeamento sem gravar campos e fica no registro', async () => {
  const response = await call('/external-requests/test', { contact_id: 'c-a', automation_id: 'auto-a', action: request() })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, status: 200, mapped: [{ path: 'data.plano', ok: true, value: 'Premium' }], preview: expect.stringContaining('Premium') })
  expect(await field('field-a')).toBe('"Curso"')
  const listed = await (await call('/external-requests/logs?automation_id=auto-a')).json() as { items: Record<string, unknown>[] }
  expect(listed.items).toEqual([expect.objectContaining({ source: 'test', outcome: 'ok', contact_name: 'Mariana Oliveira' })])
  expect((await call('/external-requests/test', { contact_id: 'c-b', action: request() })).status).toBe(404)
  expect((await call('/external-requests/test', { contact_id: 'c-a', action: request({ url: 'http://localhost/x' }) })).status).toBe(400)
})

it('registros do espaço filtram só erros e a origem, com o nome da automação', async () => {
  await bindings.DB.prepare(`INSERT INTO external_request_logs (id,workspace_id,automation_id,node_id,run_id,contact_id,source,method,target,status,outcome,error_code,message,duration_ms)
    VALUES ('l-ok','a','auto-a',NULL,NULL,'c-a','run','GET','api.x',200,'ok',NULL,NULL,5),('l-dyn','a','auto-a','dyn',NULL,'c-a','run','POST','https://dyn.x',NULL,'error','dynamic','fora',3),
    ('l-err','a','auto-a',NULL,NULL,'c-a','run','GET','api.x',500,'error','http_status','500',4),('l-b','b',NULL,NULL,NULL,NULL,'test','GET','api.x',500,'error','http_status','x',1)`).run()
  const list = async (q: string) => ((await (await call(`/external-requests/logs?${q}`)).json()) as { items: { id: string; kind: string; automation_name: string }[] }).items
  expect((await list('')).map(i => i.id).sort()).toEqual(['l-dyn', 'l-err', 'l-ok'])
  expect((await list('errors=1')).map(i => i.id).sort()).toEqual(['l-dyn', 'l-err'])
  expect(await list('kind=dynamic')).toEqual([expect.objectContaining({ id: 'l-dyn', kind: 'dynamic', automation_name: expect.any(String) })])
  await bindings.DB.prepare(`INSERT INTO external_request_logs (id,workspace_id,automation_id,node_id,run_id,contact_id,source,method,target,status,outcome,error_code,message,duration_ms,created_at)
    VALUES ('l-slow','a',NULL,NULL,NULL,'c-a','run','GET','api.x',200,'ok',NULL,NULL,6000,?),('l-old','a',NULL,NULL,NULL,'c-a','run','GET','api.x',500,'error','http_status','x',1,?)`).bind(Date.now(), Date.now() - 15 * 86_400_000).run()
  expect((await list('level=warning')).map(i => i.id)).toEqual(['l-slow'])
  expect((await list('level=info')).map(i => i.id)).toEqual(['l-ok'])
  expect((await list('')).map(i => i.id)).not.toContain('l-old')
})
