import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

beforeEach(async () => { await seedAuth() })
const request = (path: string, method = 'GET', body?: unknown) => authenticatedRequest(path, 'a', {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

it('salva nome, pausa, campo e status sem tocar outro espaço nem enviar mensagens', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rede não autorizada'))
  try {
    expect((await request('contacts/c-a', 'PATCH', { first_name: 'Ana', status: 'unsubscribed' })).status).toBe(200)
    expect((await request('contacts/c-a/pause', 'PUT', { until: '2027-01-01T12:00:00Z' })).status).toBe(200)
    expect((await request('contacts/c-a/fields/field-a', 'PUT', { value: 'Recife' })).status).toBe(200)
    const detail = await (await request('contacts/c-a')).json() as any
    expect(detail.contact).toMatchObject({ first_name: 'Ana', status: 'unsubscribed', automation_paused_until: '2027-01-01T12:00:00.000Z' })
    expect(detail.channels[0].opted_in).toBe(true)
    expect(detail.field_values).toEqual([{ contact_id: 'c-a', field_id: 'field-a', value: 'Recife' }])
    expect((await request('contacts/c-b', 'PATCH', { first_name: 'Invasão' })).status).toBe(404)
    expect(await env.DB.prepare("SELECT first_name FROM contacts WHERE id='c-b'").first('first_name')).toBe('Mariana')
    expect((await request('contacts/c-a/pause', 'PUT', { until: null })).status).toBe(200)
    expect((await request('contacts/c-a', 'PATCH', { status: 'subscribed' })).status).toBe(200)
    const resumed = await (await request('contacts/c-a')).json() as any
    expect(resumed.contact.automation_paused_until).toBeNull()
    expect(resumed.channels[0].opted_in).toBe(true)
    expect(network).not.toHaveBeenCalled()
  } finally { network.mockRestore() }
})

it('tags reais são criadas e aplicadas em lote de forma idempotente e isolada', async () => {
  const created = await request('tags', 'POST', { name: 'Nova tag' })
  expect(created.status).toBe(201)
  const tag = await created.json() as any
  expect((await request('tags', 'POST', { name: 'Nova tag' })).status).toBe(409)
  for (const [op, count] of [['add', 1], ['add', 0], ['remove', 1]] as const) {
    const response = await request('contacts/bulk-tag', 'POST', { ids: ['c-a', 'c-a'], tag_id: tag.id, op })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ count })
  }
  expect((await request('contacts/bulk-tag', 'POST', { ids: ['c-a', 'c-b'], tag_id: tag.id, op: 'add' })).status).toBe(404)
  expect((await request('contacts/bulk-tag', 'POST', { ids: ['c-a'], tag_id: 'tag-b', op: 'add' })).status).toBe(404)
  expect((await (await request('contacts/c-a')).json() as any).tags.map((t: any) => t.id)).toEqual(['tag-a'])
})

it('recusa valores incompatíveis, apagados e papéis sem edição', async () => {
  await env.DB.prepare("INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('number-a','a','Quantidade','number')").run()
  expect((await request('contacts/c-a/fields/number-a', 'PUT', { value: 'dez' })).status).toBe(400)
  expect((await request('contacts/c-a/fields/number-a', 'PUT', { value: 10 })).status).toBe(200)
  expect((await request('contacts/c-a/fields/number-a', 'PUT', { value: null })).status).toBe(200)
  expect((await request('contacts/c-a', 'PATCH', { status: 'deleted' })).status).toBe(400)
  expect((await request('contacts/c-a', 'PATCH', { workspace_id: 'b' })).status).toBe(400)
  await env.DB.prepare("UPDATE contacts SET status='deleted' WHERE id='c-a'").run()
  expect((await request('contacts/c-a/pause', 'PUT', { until: null })).status).toBe(404)
  expect((await request('contacts/bulk-tag', 'POST', { ids: ['c-a'], tag_id: 'tag-a', op: 'add' })).status).toBe(404)
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE workspace_id='a'").run()
  expect((await request('tags', 'POST', { name: 'Sem permissão' })).status).toBe(403)
  expect((await request('contacts/c-a', 'PATCH', { first_name: 'Não' })).status).toBe(403)
})

it('perfil expõe nomes e fichas efetivas de conexões do mesmo canal separadamente', async () => {
  await env.DB.prepare(`UPDATE channels SET display_name='Conta principal',capabilities_override='{"initiator":"business_with_optin"}' WHERE id='ch-a'`).run()
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id,display_name) VALUES ('ch-a-2','a','instagram','conta-2','Conta secundária')").run()
  await env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('cc-a-2','a','c-a','ch-a-2','outro',0)").run()
  const detail = await (await request('contacts/c-a')).json() as any
  expect(detail.channels.map((ch: any) => [ch.connection_name, ch.opted_in, ch.connection_profile.initiator])).toEqual([
    ['Conta principal', true, 'business_with_optin'], ['Conta secundária', false, 'user'],
  ])
  expect(JSON.stringify(detail)).not.toMatch(/credentials_|capabilities_override/)
  await request('contacts/c-a', 'PATCH', { status: 'unsubscribed' })
  await request('contacts/c-a', 'PATCH', { status: 'subscribed' })
  const resumed = await (await request('contacts/c-a')).json() as any
  expect(resumed.channels.map((ch: any) => ch.opted_in)).toEqual([true, false])
})

it.each(['livechat_agent', 'viewer'] as const)('papel %s: só o atendente pausa e retoma a automação do contato', async role => {
  await env.DB.prepare('UPDATE workspace_members SET role=? WHERE id=?').bind(role, 'member-a').run()
  const pause = await request('contacts/c-a/pause', 'PUT', { until: '2027-01-01T12:00:00Z' })
  expect(pause.status).toBe(role === 'livechat_agent' ? 200 : 403)
  const resume = await request('contacts/c-a/pause', 'PUT', { until: null })
  expect(resume.status).toBe(role === 'livechat_agent' ? 200 : 403)
  // Nada além da pausa muda para o atendente.
  expect((await request('contacts/c-a', 'PATCH', { first_name: 'Outro' })).status).toBe(403)
})
