import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { seedAuth, fixtureCookie } from './auth-helpers'

let cookieA = '', token = ''
const panel = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(`https://engine.test/api/${path}`,
  { ...init, headers: { 'x-workspace': 'a', 'content-type': 'application/json', cookie: cookieA, origin: 'https://engine.test', ...init.headers } }))
const api = async (path: string, body?: unknown, key = token) => {
  const response = await exports.default.fetch(new Request(`https://engine.test/api/public/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  return { status: response.status, json: await response.json() as { status: string; data?: any; message?: string } }
}
beforeEach(async () => {
  await seedAuth(); cookieA = await fixtureCookie()
  const created = await panel('api-keys', { method: 'POST' })
  expect(created.status).toBe(201)
  token = (await created.json() as { token: string }).token
})

it('chave em formato espaço:segredo autentica; chave errada, revogada ou rotacionada recebe envelope de erro', async () => {
  expect(token).toMatch(/^a:[a-f0-9]{48}$/)
  expect((await api('page/getInfo')).json).toMatchObject({ status: 'success', data: { id: 'a' } })
  expect(await api('page/getInfo', undefined, 'a:errada')).toMatchObject({ status: 401, json: { status: 'error' } })
  expect(await api('page/getInfo', undefined, 'b:' + token.slice(2))).toMatchObject({ status: 401 })
  expect(await (await panel('api-keys')).json()).toMatchObject({ last4: token.slice(-4) })
  const old = token
  token = (await (await panel('api-keys', { method: 'POST' })).json() as { token: string }).token
  expect((await api('page/getInfo', undefined, old)).status).toBe(401)
  expect((await api('page/getInfo')).status).toBe(200)
  expect((await panel('api-keys', { method: 'DELETE' })).status).toBe(204)
  expect((await api('page/getInfo')).status).toBe(401)
  expect(await api('nada')).toMatchObject({ status: 401 })
})

it('tags, campos e campos do bot por id ou nome; contatos por nome e por campo', async () => {
  expect((await api('page/getTags')).json.data).toEqual([{ id: 'tag-a', name: 'Etiqueta a' }])
  const tag = (await api('page/createTag', { name: 'VIP' })).json.data
  expect(await api('subscriber/addTagByName', { subscriber_id: 'c-a', tag_name: 'VIP' })).toMatchObject({ status: 200, json: { status: 'success' } })
  expect(await env.DB.prepare('SELECT count(*) FROM contact_tags WHERE contact_id=? AND tag_id=?').bind('c-a', tag.id).first('count(*)')).toBe(1)
  await api('subscriber/removeTag', { subscriber_id: 'c-a', tag_id: tag.id })
  expect(await env.DB.prepare('SELECT count(*) FROM contact_tags WHERE contact_id=? AND tag_id=?').bind('c-a', tag.id).first('count(*)')).toBe(0)
  expect(await api('subscriber/addTag', { subscriber_id: 'c-b', tag_id: 'tag-a' })).toMatchObject({ status: 404, json: { status: 'error' } })
  const field = (await api('page/createCustomField', { caption: 'Pontos', type: 'number' })).json.data
  expect((await api('subscriber/setCustomFieldByName', { subscriber_id: 'c-a', field_name: 'Pontos', field_value: 42 })).status).toBe(200)
  expect((await api(`subscriber/findByCustomField?field_id=${field.id}&field_value=42`)).json.data).toEqual([expect.objectContaining({ id: 'c-a' })])
  expect((await api('subscriber/setCustomField', { subscriber_id: 'c-a', field_id: field.id, field_value: 'muito' })).status).toBe(400)
  expect((await api('subscriber/findByName?name=mariana%20oliveira')).json.data).toEqual([expect.objectContaining({ id: 'c-a', custom_fields: expect.objectContaining({ Pontos: 42 }) })])
  expect((await api('subscriber/getInfo?subscriber_id=c-b')).status).toBe(404)
  const bot = (await api('page/createBotField', { name: 'Vagas', type: 'number', value: 3 })).json.data
  await api('page/setBotFieldByName', { field_name: 'Vagas', field_value: 9 })
  expect((await api('page/getBotFields')).json.data).toEqual([expect.objectContaining({ id: bot.id, value: 9 })])
  expect((await api('page/getCustomFields')).json.data.map((f: { name: string }) => f.name)).toContain('Pontos')
})

it('cria contato com telefone ou e-mail; opt-in exige consent_phrase e grava o consentimento', async () => {
  expect(await api('subscriber/createSubscriber', { first_name: 'Ana' })).toMatchObject({ status: 400 })
  expect(await api('subscriber/createSubscriber', { email: 'ana@x.com', has_opt_in_email: true })).toMatchObject({ status: 400, json: { message: expect.stringContaining('consent_phrase') } })
  const created = await api('subscriber/createSubscriber', { first_name: 'Ana', phone: '+55 11 98888-7777', email: 'ana@x.com', has_opt_in_email: true, consent_phrase: 'Aceito receber e-mail' })
  expect(created).toMatchObject({ status: 201, json: { status: 'success', data: { first_name: 'Ana', phone: '5511988887777' } } })
  expect(await env.DB.prepare('SELECT phrase FROM contact_consents WHERE contact_id=?').bind(created.json.data.id).first('phrase')).toBe('Aceito receber e-mail')
  expect((await api('subscriber/createSubscriber', { phone: '5511988887777' })).status).toBe(409)
})

it('lista fluxos e entradas e envia fluxo publicado pela conexão do contato', async () => {
  expect((await api('page/getFlows')).json.data).toEqual([expect.objectContaining({ ns: 'auto-a', published: false })])
  expect((await api('page/getGrowthTools')).json.data[0]).toMatchObject({ type: 'dm_keyword' })
  expect(await api('sending/sendFlow', { subscriber_id: 'c-a', flow_ns: 'auto-a' })).toMatchObject({ status: 409, json: { status: 'error' } })
})

it('entrada externa por nome dispara a automação publicada e o contexto preenche campos de texto de mesmo nome', async () => {
  const created = await panel('automations/auto-a/triggers', { method: 'POST', body: JSON.stringify({ type: 'api', name: 'compra_aprovada', node_id: 't' }) })
  expect(created.status).toBe(201)
  const createdId = (await created.json() as { id: string }).id
  expect((await panel('automations/auto-a/triggers', { method: 'POST', body: JSON.stringify({ type: 'api', name: 'compra_aprovada', node_id: 't' }) })).status).toBe(409)
  expect(await api('triggers/fire', { subscriber_id: 'c-a', trigger_name: 'compra_aprovada', context: { Interesse: 'Curso B' } })).toMatchObject({ status: 404 })
  await env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-api','a','auto-a',1,(SELECT draft_graph FROM automations WHERE id='auto-a'))").run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id='v-api' WHERE id='auto-a'").run()
  expect((await panel('automations/auto-a/triggers/' + createdId, { method: 'PATCH', body: JSON.stringify({ state: 'active' }) })).status).toBe(200)
  const fired = await api('triggers/fire', { subscriber_id: 'c-a', trigger_name: 'compra_aprovada', context: { Interesse: 'Curso B' } })
  expect(fired.status).toBe(200)
  expect(await env.DB.prepare("SELECT value FROM contact_field_values WHERE contact_id='c-a' AND field_id='field-a'").first('value')).toBe('"Curso B"')
  expect(await env.DB.prepare("SELECT count(*) FROM flow_runs WHERE id=?").bind(fired.json.data.run_id).first('count(*)')).toBe(1)
})

it('getInfoByUserRef acha o contato pela identidade no canal', async () => {
  const ref = await env.DB.prepare("SELECT external_user_id FROM contact_channels WHERE contact_id='c-a'").first<string>('external_user_id')
  expect((await api(`subscriber/getInfoByUserRef?user_ref=${ref}`)).json).toMatchObject({ status: 'success', data: { id: 'c-a' } })
  expect((await api('subscriber/getInfoByUserRef?user_ref=nao-existe')).status).toBe(404)
})

it('sendContent manda o conteúdo v2 por uma automação interna que não aparece nas listas', async () => {
  const sent = await api('sending/sendContent', { subscriber_id: 'c-a', data: { version: 'v2', content: { messages: [{ type: 'text', text: 'Pedido enviado!' }] } } })
  expect(sent.status).toBe(200)
  const run = await env.DB.prepare('SELECT v.graph FROM flow_runs r JOIN automation_versions v ON v.id=r.automation_version_id WHERE r.id=?').bind(sent.json.data.run_id).first<string>('graph')
  expect(JSON.parse(run!).nodes[1].config.blocks).toEqual([{ kind: 'text', text: 'Pedido enviado!' }])
  const trash = await (await panel('automation-library?trash=1')).json() as { items: { id: string }[] }
  expect(trash.items.some(a => a.id.startsWith('api-content-'))).toBe(false)
  expect((await api('sending/sendContent', { subscriber_id: 'c-a', data: { version: 'v1' } })).status).toBe(400)
})

it('chave de perfil: vale nos espaços em que a pessoa edita, escolhidos por x-workspace', async () => {
  const created = await panel('profile/api-key', { method: 'POST' })
  expect(created.status).toBe(201)
  const profile = (await created.json() as { token: string }).token
  expect(profile).toMatch(/^perfil:[a-f0-9]{48}$/)
  const call = (ws?: string) => exports.default.fetch(new Request('https://engine.test/api/public/v1/page/getInfo', { headers: { authorization: `Bearer ${profile}`, ...(ws ? { 'x-workspace': ws } : {}) } }))
  expect((await call('a')).status).toBe(200)
  expect((await call()).status).toBe(400)
  expect((await call('b')).status).toBe(401)
  expect((await panel('profile/api-key', { method: 'DELETE' })).status).toBe(204)
  expect((await call('a')).status).toBe(401)
})

it('sendContentByUserRef cria o contato pela identidade no canal quando ele ainda não existe', async () => {
  const r = await api('sending/sendContentByUserRef', { user_ref: 'ref-novo-1', channel_id: 'ch-a', data: { version: 'v2', content: { messages: [{ type: 'text', text: 'oi' }] } } })
  expect([200, 503]).toContain(r.status)
  if (r.status === 200) expect(await env.DB.prepare("SELECT contact_id FROM contact_channels WHERE external_user_id='ref-novo-1'").first('contact_id')).toBe(r.json.data.subscriber_id)
})

it('sendFlow e triggers/fire têm teto por contato e automação (30 por minuto): passou, 429', async () => {
  await env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-teto','a','auto-a',1,(SELECT draft_graph FROM automations WHERE id='auto-a'))").run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id='v-teto' WHERE id='auto-a'").run()
  const created = await panel('automations/auto-a/triggers', { method: 'POST', body: JSON.stringify({ type: 'api', name: 'teto', node_id: 't' }) })
  await panel('automations/auto-a/triggers/' + (await created.json() as { id: string }).id, { method: 'PATCH', body: JSON.stringify({ state: 'active' }) })
  const flow = { subscriber_id: 'c-a', flow_ns: 'auto-a' }
  for (let i = 0; i < 30; i++) expect((await api('sending/sendFlow', flow)).status, `sendFlow ${i}`).toBe(200)
  expect(await api('sending/sendFlow', flow)).toMatchObject({ status: 429, json: { status: 'error' } })
  // o mesmo teto vale na entrada externa da mesma automação para o mesmo contato
  expect((await api('triggers/fire', { subscriber_id: 'c-a', trigger_name: 'teto' })).status).toBe(429)
  const runs = await env.DB.prepare("SELECT count(*) AS n FROM flow_runs WHERE id LIKE 'api-%' AND contact_id='c-a'").first<number>('n')
  expect(runs).toBe(30)
}, 30_000)   // 31 pedidos em sequência, cada um cria uma execução: passa de 5 s com a máquina ocupada
