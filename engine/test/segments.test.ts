import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { condition } from '../src/flow/nodes'
import { processBroadcastBatch } from '../src/db/broadcasts'
import { giveCredentials } from './credentials'
import type { Run } from '../src/flow/types'

beforeEach(seedAuth)
const request = (path: string, method = 'GET', body?: unknown, workspace = 'a') => authenticatedRequest(path, workspace, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const filter = { match: 'all', rules: [{ type: 'tag', tag_id: 'tag-a', operator: 'has' }, { type: 'field', field_id: 'field-a', operator: 'contains', value: 'Cur' }] }

it('consulta no motor, salva e reabre um segmento dinâmico isolado por espaço sem rede', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rede proibida'))
  try {
    const queried = await request('contacts/query', 'POST', { filter })
    expect(queried.status).toBe(200)
    expect(await queried.json()).toMatchObject({ total: 1, rows: [{ id: 'c-a' }], next_cursor: null })
    const saved = await request('segments', 'POST', { name: 'Interessados', filter })
    expect(saved.status).toBe(201)
    const segment = await saved.json() as any
    expect(segment).toMatchObject({ name: 'Interessados', total: 1, filter })
    expect(await (await request(`segments/${segment.id}`)).json()).toMatchObject(segment)
    expect((await request(`segments/${segment.id}`, 'GET', undefined, 'b')).status).toBe(404)
    expect(await (await request('segments')).json()).toContainEqual(segment)
    expect((await request('segments', 'POST', { name: 'interessados', filter })).status).toBe(409)
    expect(await (await request(`segments/${segment.id}`, 'PUT', { name: 'Interessados atuais', filter })).json()).toMatchObject({ name: 'Interessados atuais', total: 1 })
    expect((await request(`segments/${segment.id}`, 'PUT', { name: 'Outro espaço', filter }, 'b')).status).toBe(404)
    expect(await (await request('contacts/query', 'POST', { filter: { match: 'any', rules: [{ type: 'system', field: 'first_name', operator: 'equals', value: 'Não existe' }, { type: 'tag', tag_id: 'tag-a', operator: 'has' }] } })).json()).toMatchObject({ total: 1 })
    expect((await request('contacts/query', 'POST', { filter: { match: 'all', rules: [{ type: 'field', field_id: 'field-b', operator: 'equals', value: 'Curso' }] } })).status).toBe(404)
    const rule = { type: 'segment', segment_id: segment.id, operator: 'in' }
    const run = { workspace_id: 'a', contact_id: 'c-a' } as Run
    expect(await condition(env, run, { match: 'all', rules: [rule] })).toBe('true')
    await env.DB.prepare("DELETE FROM contact_tags WHERE contact_id='c-a'").run()
    expect(await (await request(`segments/${segment.id}`)).json()).toMatchObject({ total: 0 })
    expect(await condition(env, run, { match: 'all', rules: [rule] })).toBe('false')
    expect(await condition(env, run, { match: 'all', rules: [{ ...rule, operator: 'not_in' }] })).toBe('true')
    await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE workspace_id='a'").run()
    expect((await request(`segments/${segment.id}`, 'DELETE')).status).toBe(403)
    await env.DB.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id='a'").run()
    expect((await request(`segments/${segment.id}`, 'DELETE')).status).toBe(200)
    expect((await request(`segments/${segment.id}`)).status).toBe(404)
    expect(network).not.toHaveBeenCalled()
  } finally { network.mockRestore() }
})

it('valida operadores por tipo, datas relativas e a janela da ficha efetiva da conexão', async () => {
  await env.DB.prepare("UPDATE contacts SET last_interaction_at=? WHERE id='c-a'").bind(Date.now() - 86400000).run()
  const query = async (rules: unknown[]) => request('contacts/query', 'POST', { filter: { match: 'all', rules } })
  expect(await (await query([{ type: 'system', field: 'last_interaction_at', operator: 'within_last_days', value: 2 }])).json()).toMatchObject({ total: 1 })
  expect((await query([{ type: 'field', field_id: 'field-a', operator: 'gt', value: 5 }])).status).toBe(400)
  expect((await query([{ type: 'system', field: 'status', operator: 'contains', value: 'subscribed' }])).status).toBe(400)
  expect((await query([{ type: 'system', field: 'status', operator: 'equals', value: 'desconhecido' }])).status).toBe(400)
  await env.DB.batch([
    env.DB.prepare("INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('number-field','a','Pontuação','number')"),
    env.DB.prepare("INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES ('a','c-a','number-field','15')"),
  ])
  expect(await (await query([{ type: 'field', field_id: 'number-field', operator: 'gt', value: 10 }])).json()).toMatchObject({ total: 1 })
  expect((await query([{ type: 'field', field_id: 'number-field', operator: 'equals', value: '15' }])).status).toBe(400)
  // Conta conectada: quem tem conversa naquela conta; conta de outro espaço ou inexistente é recusada.
  expect(await (await query([{ type: 'connection', connection_id: 'ch-a', operator: 'in_connection' }])).json()).toMatchObject({ total: 1 })
  expect(await (await query([{ type: 'connection', connection_id: 'ch-a', operator: 'not_in_connection' }])).json()).toMatchObject({ total: 0 })
  expect((await query([{ type: 'connection', connection_id: 'nao-existe', operator: 'in_connection' }])).status).toBe(404)
  expect(((await (await request('segments/options')).json()) as any).accounts).toContainEqual(expect.objectContaining({ id: 'ch-a' }))
  await env.DB.prepare("UPDATE contact_channels SET window_expires_at=? WHERE id='cc-a'").bind(Date.now() + 3600000).run()
  expect(await (await query([{ type: 'window24', connection_id: 'ch-a', operator: 'inside' }])).json()).toMatchObject({ total: 1 })
  await env.DB.prepare("UPDATE channels SET capabilities_override=? WHERE id='ch-a'").bind(JSON.stringify({ remove: ['window'] })).run()
  expect((await query([{ type: 'window24', connection_id: 'ch-a', operator: 'inside' }])).status).toBe(400)
  const options = await (await request('segments/options')).json() as any
  expect(options.fields).toContainEqual({ id: 'field-a', name: 'Interesse', type: 'text' })
  expect(options.connections).toEqual([])
})

it('pagina 40 contatos sem perder a contagem total e recusa cursor de outro espaço', async () => {
  await env.DB.batch(Array.from({ length: 45 }, (_, i) => env.DB.prepare('INSERT INTO contacts(id,workspace_id,first_name,subscribed_at) VALUES (?,?,?,?)').bind(`page-${i}`, 'a', 'Pessoa', i + 2000)))
  const body = { filter: { match: 'any', rules: [{ type: 'system', field: 'first_name', operator: 'equals', value: 'Pessoa' }] } }
  const first = await (await request('contacts/query', 'POST', body)).json() as any
  expect(first).toMatchObject({ total: 45 })
  expect(first.rows).toHaveLength(40)
  const second = await (await request('contacts/query', 'POST', { ...body, cursor: first.next_cursor })).json() as any
  expect(second).toMatchObject({ total: 45, next_cursor: null })
  expect(second.rows).toHaveLength(5)
  expect((await request('contacts/query', 'POST', { ...body, cursor: first.next_cursor }, 'b')).status).toBe(400)
})

it('a transmissão persiste o segmento e atualiza sua contagem dinamicamente sem enviar', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rede proibida'))
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('segment-connection','a','telegram','segment-test')"),
      env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('segment-link','a','c-a','segment-connection','segment-user',1)"),
    ])
    const segment = await (await request('segments', 'POST', { name: 'Curso', filter })).json() as any
    const audience = { tag: 'all', channel: 'telegram', channel_id: 'segment-connection', segment_id: segment.id }
    const saved = await request('broadcasts', 'POST', { name: 'Oferta', content: 'Conteúdo local', status: 'draft', audience })
    expect(saved.status).toBe(201)
    const broadcast = await saved.json() as any
    expect(broadcast).toMatchObject({ audience })
    const query = new URLSearchParams(audience)
    expect(await (await request(`broadcasts/audience?${query}`)).json()).toMatchObject({ count: 1, eligible: 1 })
    await env.DB.prepare("DELETE FROM contact_tags WHERE contact_id='c-a'").run()
    expect(await (await request(`broadcasts/audience?${query}`)).json()).toMatchObject({ count: 0, eligible: 0 })
    const options = await (await request('broadcasts/options')).json() as any
    expect(options.segments).toContainEqual({ id: segment.id, name: 'Curso' })
    await giveCredentials(env, 'segment-connection', { botToken: 'TESTONLY', webhookSecret: 'segment-secret' })
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name) VALUES ('segment-added','a','Nova pessoa')"),
      env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('segment-added-link','a','segment-added','segment-connection','added-user',1)"),
      env.DB.prepare("INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES ('a','segment-added','tag-a')"),
      env.DB.prepare("INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES ('a','segment-added','field-a','\"Curso\"')"),
      env.DB.prepare("UPDATE broadcasts SET status='scheduled',scheduled_at=1 WHERE id=?").bind(broadcast.id),
    ])
    // Stop immediately after the transactional audience snapshot, before any send.
    await expect(processBroadcastBatch(env, 'a', broadcast.id, () => { throw new Error('snapshot-inspected') })).rejects.toThrow('snapshot-inspected')
    const recipients = await env.DB.prepare('SELECT cc.contact_id FROM broadcast_recipients r JOIN contact_channels cc ON cc.id=r.contact_channel_id WHERE broadcast_id=?').bind(broadcast.id).all()
    expect(recipients.results).toEqual([{ contact_id: 'segment-added' }])
    expect(network).not.toHaveBeenCalled()
  } finally { network.mockRestore() }
})

it('mantém segmentos válidos disponíveis quando outra referência foi removida e permite editar o filtro inválido', async () => {
  const validFilter = { match: 'all', rules: [{ type: 'system', field: 'first_name', operator: 'equals', value: 'Mariana' }] }
  const valid = await (await request('segments', 'POST', { name: 'Nome preservado', filter: validFilter })).json() as any
  const invalid = await (await request('segments', 'POST', { name: 'Tag removida', filter })).json() as any
  await env.DB.prepare("DELETE FROM tags WHERE id='tag-a'").run()
  const list = await request('segments')
  expect(list.status).toBe(200)
  expect(await list.json()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: valid.id, total: 1 }),
    expect.objectContaining({ id: invalid.id, filter, total: null, error: expect.any(String) }),
  ]))
  const detail = await request(`segments/${invalid.id}`)
  expect(detail.status).toBe(200)
  expect(await detail.json()).toMatchObject({ id: invalid.id, filter, total: null, error: expect.any(String) })
  await expect(condition(env, { workspace_id: 'a', contact_id: 'c-a' } as Run, { match: 'all', rules: [{ type: 'segment', segment_id: invalid.id, operator: 'in' }] })).rejects.toMatchObject({ status: 404 })
  const fixed = await request(`segments/${invalid.id}`, 'PUT', { name: 'Tag removida', filter: validFilter })
  expect(fixed.status).toBe(200)
  expect(await fixed.json()).toMatchObject({ id: invalid.id, filter: validFilter, total: 1 })
})

it('segmentos gerais e de e-mail coexistem nas listas e nas condições sem chamadas de rede', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rede proibida'))
  try {
    const generalFilter = { match: 'all', rules: [{ type: 'system', field: 'status', operator: 'equals', value: 'subscribed' }] }
    const generalResponse = await request('segments', 'POST', { name: 'Inscritos gerais', filter: generalFilter })
    expect(generalResponse.status).toBe(201)
    const general = await generalResponse.json() as { id: string }
    const emailResponse = await request('email/segments', 'POST', { name: 'Sem endereço', filter: { match: 'all', rules: [{ type: 'email', filter: 'undefined' }] } })
    expect(emailResponse.status).toBe(201)
    const email = await emailResponse.json() as { id: string }
    const listed = await request('segments')
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: general.id, filterKind: 'general', total: 1 }),
      expect.objectContaining({ id: email.id, filterKind: 'email', total: 1 }),
    ]))
    const run = { workspace_id: 'a', contact_id: 'c-a' } as Run
    expect(await condition(env, run, { match: 'all', rules: [{ type: 'segment', segment_id: email.id, operator: 'in' }, { type: 'segment', segment_id: general.id, operator: 'has' }] })).toBe('true')
    expect(await (await request(`contacts?segment_id=${general.id}`)).json()).toMatchObject({ total: 1 })
    expect(network).not.toHaveBeenCalled()
  } finally { network.mockRestore() }
})

it('mantém a lista utilizável quando um segmento de e-mail referencia outro removido', async () => {
  const general = await (await request('segments', 'POST', { name: 'Origem geral', filter })).json() as { id: string }
  const emailResponse = await request('email/segments', 'POST', { name: 'Leitores da origem', filter: { match: 'all', rules: [{ type: 'segment', segment_id: general.id, operator: 'has' }] } })
  expect(emailResponse.status).toBe(201)
  const email = await emailResponse.json() as { id: string }
  expect((await request(`segments/${general.id}`, 'DELETE')).status).toBe(200)
  const listed = await request('segments')
  expect(listed.status).toBe(200)
  expect(await listed.json()).toContainEqual(expect.objectContaining({ id: email.id, total: null, error: expect.any(String) }))
})

it('inscrição por canal: inscrito com recebimento autorizado numa conexão do canal', async () => {
  const total = async (channel: string, operator: string) => (await (await request('contacts/query', 'POST', { filter: { match: 'all', rules: [{ type: 'channel', channel, operator }] } })).json() as { total: number }).total
  const type = (await env.DB.prepare("SELECT type FROM channels WHERE id='ch-a'").first<string>('type'))!
  const other = type === 'tiktok' ? 'email' : 'tiktok'
  expect(await total(type, 'subscribed')).toBe(1)
  expect(await total(other, 'subscribed')).toBe(0)
  expect(await total(other, 'not_subscribed')).toBe(1)
  await env.DB.prepare("UPDATE contact_channels SET opted_in=0 WHERE contact_id='c-a'").run()
  expect(await total(type, 'subscribed')).toBe(0)
  expect((await request('contacts/query', 'POST', { filter: { match: 'all', rules: [{ type: 'channel', channel: 'orkut', operator: 'subscribed' }] } })).status).toBe(400)
})

it('texto ignora maiúsculas salvo com case_sensitive; lista contém item; gênero só "é"; segmentos de follow-up', async () => {
  const total = async (rules: unknown[]) => { const r = await request('contacts/query', 'POST', { filter: { match: 'all', rules } }); return r.status === 200 ? (await r.json() as { total: number }).total : r.status }
  expect(await total([{ type: 'field', field_id: 'field-a', operator: 'equals', value: 'curso' }])).toBe(1)
  expect(await total([{ type: 'field', field_id: 'field-a', operator: 'equals', value: 'curso', case_sensitive: true }])).toBe(0)
  expect(await total([{ type: 'field', field_id: 'field-a', operator: 'contains', value: 'URS' }])).toBe(1)
  expect(await total([{ type: 'field', field_id: 'field-a', operator: 'not_contains', value: 'urs' }])).toBe(0)
  await env.DB.batch([
    env.DB.prepare("INSERT INTO custom_fields (id,workspace_id,scope,name,type) VALUES ('lista-a','a','contact','Interesses','array')"),
    env.DB.prepare(`INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value) VALUES ('a','c-a','lista-a','["moto","carro"]')`),
    env.DB.prepare("UPDATE contacts SET gender='female' WHERE id='c-a'"),
  ])
  expect(await total([{ type: 'field', field_id: 'lista-a', operator: 'contains', value: 'moto' }])).toBe(1)
  expect(await total([{ type: 'field', field_id: 'lista-a', operator: 'not_contains', value: 'moto' }])).toBe(0)
  expect(await total([{ type: 'field', field_id: 'lista-a', operator: 'not_contains', value: 'barco' }])).toBe(1)
  expect(await total([{ type: 'system', field: 'gender', operator: 'equals', value: 'female' }])).toBe(1)
  expect(await total([{ type: 'system', field: 'gender', operator: 'not_equals', value: 'female' }])).toBe(400)
})
