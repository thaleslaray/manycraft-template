import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest as request, seedAuth } from './auth-helpers'
import { createField, setFieldValue } from '../src/db/fields'

beforeEach(seedAuth)
const write = (method: string, body?: unknown) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const json = async (path: string, init?: RequestInit) => (await request(path, 'a', init)).json() as Promise<any>

it('persiste criação, nome, pasta, arquivo e exclusão de campos e tags sem misturar workspaces', async () => {
  for (const kind of ['fields', 'tags']) {
    const folderResponse = await request('settings-folders', 'a', write('POST', { kind, name: 'Campanha' }))
    expect(folderResponse.status).toBe(201)
    const folder = await folderResponse.json() as { id: string }
    const created = await request(kind, 'a', write('POST', { name: 'Interesse novo', folder_id: folder.id, ...(kind === 'fields' ? { type: 'text' } : {}) }))
    expect(created.status).toBe(201)
    const item = await created.json() as { id: string }
    expect(await json(`${kind}/${item.id}`, write('PATCH', { name: 'Interesse final', archived: true }))).toMatchObject({ name: 'Interesse final', archived: true, folder_id: folder.id })
    expect(await json(kind)).toContainEqual(expect.objectContaining({ id: item.id, archived: true }))
    expect((await request(`${kind}/${item.id}`, 'b', write('PATCH', { name: 'Não pode' }))).status).toBe(404)
    expect((await request(`${kind}/${item.id}`, 'b', write('DELETE'))).status).toBe(404)
    expect(await json(`${kind}/${item.id}`, write('PATCH', { archived: false }))).toMatchObject({ archived: false })
    expect((await request(`settings-folders/${folder.id}`, 'a', write('DELETE'))).status).toBe(200)
    expect(await json(kind)).toContainEqual(expect.objectContaining({ id: item.id, folder_id: null }))
    expect((await request(`${kind}/${item.id}`, 'a', write('DELETE'))).status).toBe(200)
    expect(await json(kind)).not.toContainEqual(expect.objectContaining({ id: item.id }))
  }
  expect(await json('tags')).toContainEqual(expect.objectContaining({ id: 'tag-a', contact_count: 1 }))
})

it('recusa pastas de outro tipo/workspace, duplicados e mutação sem papel de editor', async () => {
  const folder = await json('settings-folders', write('POST', { kind: 'tags', name: 'Pasta' }))
  expect((await request('fields', 'a', write('POST', { name: 'Número', type: 'number', folder_id: folder.id }))).status).toBe(400)
  expect((await request('tags', 'b', write('POST', { name: 'Outro', folder_id: folder.id }))).status).toBe(400)
  expect((await request('tags', 'a', write('POST', { name: 'Etiqueta a' }))).status).toBe(409)
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE workspace_id='a'").run()
  expect((await request('tags', 'a', write('POST', { name: 'Proibida' }))).status).toBe(403)
})

it('avisa o nome da automação publicada antes de excluir e exige confirmação explícita', async () => {
  const graph = { nodes: [{ id: 'action', type: 'action', config: { actions: [{ type: 'set_custom_field_value', field_id: 'field-a', value: 'x' }] } }], edges: [] }
  await env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('version-a','a','auto-a',1,?)").bind(JSON.stringify(graph)).run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id='version-a' WHERE id='auto-a'").run()
  expect(await json('fields/field-a/usage')).toEqual({ automations: [{ id: 'auto-a', name: 'Automação a' }] })
  const response = await request('fields/field-a', 'a', write('DELETE'))
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ automations: [{ id: 'auto-a', name: 'Automação a' }] })
  expect(await env.DB.prepare("SELECT id FROM custom_fields WHERE id='field-a'").first()).not.toBeNull()
  await env.DB.prepare("UPDATE automations SET status='stopped' WHERE id='auto-a'").run()
  expect(await json('fields/field-a/usage')).toEqual({ automations: [{ id: 'auto-a', name: 'Automação a' }] })
  expect((await request('fields/field-a', 'a', write('DELETE'))).status).toBe(409)
  expect((await request('fields/field-a?confirm=true', 'a', write('DELETE'))).status).toBe(200)
  expect(await env.DB.prepare("SELECT field_id FROM contact_field_values WHERE field_id='field-a'").first()).toBeNull()
})

it.each([
  ['number', 42, '42'], ['boolean', true, 'true'], ['text', 'texto', 123],
  ['date', '2026-10-23', '2026-02-30'], ['datetime', '2026-10-23T12:00:00Z', 'amanhã'], ['array', ['a'], {}],
] as const)('valida valores de %s na escrita do contato e do bot', async (type, valid, invalid) => {
  const field = await createField(env.DB, 'a', { name: `Teste ${type}`, type })
  const response = await request(`contacts/c-a/fields/${field.id}`, 'a', write('PUT', { value: invalid }))
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: expect.stringContaining(type) })
  await expect(setFieldValue(env.DB, 'a', 'c-a', field.id, invalid)).rejects.toThrow(/tipo/)
  expect((await request(`contacts/c-a/fields/${field.id}`, 'a', write('PUT', { value: valid }))).status).toBe(200)
  expect((await request('fields', 'a', write('POST', { name: `Global ${type}`, type, scope: 'bot', bot_value: invalid }))).status).toBe(400)
  const bot = await json('fields', write('POST', { name: `Global ${type}`, type, scope: 'bot', bot_value: valid }))
  expect((await request(`fields/${bot.id}`, 'a', write('PATCH', { bot_value: invalid }))).status).toBe(400)
  expect((await request(`fields/${bot.id}`, 'a', write('PATCH', { bot_value: null }))).status).toBe(200)
})

it('texto vazio não limpa silenciosamente um campo numérico e valor nulo remove o valor', async () => {
  const field = await createField(env.DB, 'a', { name: 'Pontuação', type: 'number' })
  await setFieldValue(env.DB, 'a', 'c-a', field.id, 7)
  expect((await request(`contacts/c-a/fields/${field.id}`, 'a', write('PUT', { value: '' }))).status).toBe(400)
  expect(await env.DB.prepare('SELECT value FROM contact_field_values WHERE field_id=?').bind(field.id).first()).toEqual({ value: '7' })
  expect((await request(`contacts/c-a/fields/${field.id}`, 'a', write('PUT', { value: null }))).status).toBe(200)
  expect(await env.DB.prepare('SELECT value FROM contact_field_values WHERE field_id=?').bind(field.id).first()).toBeNull()
})
