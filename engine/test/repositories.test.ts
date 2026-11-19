import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import * as db from '../src/db'
import { graph, seed } from './fixtures'

beforeEach(seed)

const sql = (query: string, ...args: (string | number | null)[]) => env.DB.prepare(query).bind(...args)
const missing = async (operation: Promise<unknown>) => expect(operation).rejects.toMatchObject({ status: 404 })

// Cada função exportada de acesso a dados é exercitada com A e IDs de B.
describe('isolamento de todas as funções do repositório', () => {
  it('automações: lista, detalhe, escrita e publicação', async () => {
    expect((await db.listAutomations(env.DB, 'a')).map(a => a.id)).toEqual(['auto-a'])
    expect(await db.listAutomations(env.DB, 'a', { search: 'Automação b' })).toEqual([])
    expect(await db.listAutomations(env.DB, 'a', { folder_id: 'folder-b' })).toEqual([])
    expect(await db.getAutomation(env.DB, 'a', 'auto-b')).toBeNull()
    await missing(db.saveDraft(env.DB, 'a', 'auto-b', graph))
    await missing(db.publishAutomation(env.DB, 'a', 'auto-b'))
    expect(await db.getAutomation(env.DB, 'b', 'auto-b')).toMatchObject({ automation: { status: 'draft', draft_graph: graph }, published_version: null })
    expect(await sql('SELECT count(*) AS n FROM automation_versions WHERE workspace_id = ?', 'b').first('n')).toBe(0)
  })

  it('contatos: lista, detalhe, FTS e filtros de filhos', async () => {
    expect((await db.listContacts(env.DB, 'a')).rows.map(c => c.id)).toEqual(['c-a'])
    expect(await db.getContact(env.DB, 'a', 'c-b')).toBeNull()
    expect((await db.searchContacts(env.DB, 'a', 'Silveira')).rows).toEqual([])
    expect((await db.listContacts(env.DB, 'a', null, { tag_id: 'tag-b' })).rows).toEqual([])
    expect((await db.listContacts(env.DB, 'a', null, { trigger_id: 'trg-b' })).rows).toEqual([])
    const detail = await db.getContact(env.DB, 'a', 'c-a')
    expect(detail).toMatchObject({
      contact: { id: 'c-a', workspace_id: 'a' },
      channels: [{ channel_id: 'ch-a', channel_type: 'instagram', opted_in: true }],
      tags: [{ id: 'tag-a', contact_count: 1 }],
      field_values: [{ contact_id: 'c-a', field_id: 'field-a', value: 'Curso' }],
    })
  })

  it('tags: lista, detalhe, criação, remoção e atribuição em lote', async () => {
    expect((await db.listTags(env.DB, 'a')).map(t => t.id)).toEqual(['tag-a'])
    expect(await db.getTag(env.DB, 'a', 'tag-b')).toBeNull()
    const created = await db.createTag(env.DB, 'a', 'Nova')
    expect(created.workspace_id).toBe('a')
    expect(await db.getTag(env.DB, 'b', created.id)).toBeNull()
    await missing(db.deleteTag(env.DB, 'a', 'tag-b'))
    await missing(db.tagContacts(env.DB, 'a', ['c-a'], 'tag-b'))
    await missing(db.tagContacts(env.DB, 'a', ['c-a', 'c-b'], 'tag-a'))
    await missing(db.tagContacts(env.DB, 'a', ['c-b'], 'tag-a', 'remove'))
    expect(await db.getTag(env.DB, 'b', 'tag-b')).toMatchObject({ contact_count: 1 })
  })

  it('campos: lista, detalhe, criação e valor com os dois pais protegidos', async () => {
    expect((await db.listFields(env.DB, 'a')).map(f => f.id)).toEqual(['field-a'])
    expect(await db.getField(env.DB, 'a', 'field-b')).toBeNull()
    const field = await db.createField(env.DB, 'a', { name: 'Novo', type: 'text' })
    expect(field.workspace_id).toBe('a')
    expect(await db.getField(env.DB, 'b', field.id)).toBeNull()
    await missing(db.setFieldValue(env.DB, 'a', 'c-b', 'field-a', 'Outro'))
    await missing(db.setFieldValue(env.DB, 'a', 'c-a', 'field-b', 'Outro'))
    await missing(db.setFieldValue(env.DB, 'a', 'c-b', 'field-b', null))
    expect((await db.getContact(env.DB, 'b', 'c-b'))?.field_values[0]?.value).toBe('Curso')
  })

  it('keywords: lista, detalhe, update, criação, parent e remoção', async () => {
    expect((await db.listKeywords(env.DB, 'a')).map(k => k.id)).toEqual(['key-a'])
    expect(await db.getKeyword(env.DB, 'a', 'key-b')).toBeNull()
    const input = { trigger_id: 'trg-a', rule: 'contains' as const, words: ['novo'], priority: 2 }
    await missing(db.saveKeyword(env.DB, 'a', { ...input, id: 'key-b' }))
    await missing(db.saveKeyword(env.DB, 'a', { ...input, trigger_id: 'trg-b' }))
    await missing(db.saveKeyword(env.DB, 'a', { ...input, parent_id: 'key-b' }))
    await missing(db.deleteKeyword(env.DB, 'a', 'key-b'))
    expect(await db.getKeyword(env.DB, 'b', 'key-b')).toMatchObject({ words: ['quero'] })
    const created = await db.saveKeyword(env.DB, 'a', input)
    expect(await db.getKeyword(env.DB, 'b', created.id)).toBeNull()
  })

  it('trigger_firings: protege trigger e contato de outro workspace', async () => {
    const input = { trigger_id: 'trg-a', contact_id: 'c-a', external_event_id: 'evt', dedupe_key: 'once' }
    await missing(db.recordTriggerFiring(env.DB, 'a', { ...input, trigger_id: 'trg-b' }))
    await missing(db.recordTriggerFiring(env.DB, 'a', { ...input, contact_id: 'c-b' }))
    expect(await sql('SELECT count(*) AS n FROM trigger_firings').first('n')).toBe(0)
  })
})

it('publish cria snapshot imutável, numeração única e draft posterior preserva execução', async () => {
  const v1 = await db.publishAutomation(env.DB, 'a', 'auto-a')
  expect(v1).toMatchObject({ automation_id: 'auto-a', version: 1, graph })
  const next = structuredClone(graph)
  next.nodes[1]!.config = { blocks: [{ kind: 'text', text: 'Segunda versão' }] }
  await db.saveDraft(env.DB, 'a', 'auto-a', next)
  expect(await db.getAutomation(env.DB, 'a', 'auto-a')).toMatchObject({
    automation: { draft_graph: next, has_unpublished_changes: true, published_version_id: v1.id },
    published_version: { id: v1.id, graph },
  })
  const versions = await Promise.all([
    db.publishAutomation(env.DB, 'a', 'auto-a'), db.publishAutomation(env.DB, 'a', 'auto-a'),
  ])
  expect(versions.map(v => v.version).sort()).toEqual([2, 3])
  expect(JSON.parse(String(await sql('SELECT graph FROM automation_versions WHERE id = ?', v1.id).first('graph')))).toEqual(graph)
  expect((await db.getAutomation(env.DB, 'a', 'auto-a'))?.automation.has_unpublished_changes).toBe(false)
})

it('recusa grafos inválidos sem gravar nem publicar', async () => {
  await expect(db.saveDraft(env.DB, 'a', 'auto-a', { nodes: [{ type: 'desconhecido' }], edges: [] })).rejects.toThrow()
  await db.saveDraft(env.DB, 'a', 'auto-a', { nodes: [], edges: [] })
  await expect(db.publishAutomation(env.DB, 'a', 'auto-a')).rejects.toThrow()
  expect(await sql('SELECT count(*) AS n FROM automation_versions').first('n')).toBe(0)
})

it('cursor mantém ordem estável com datas iguais, página de 40 e isolamento', async () => {
  await env.DB.batch(Array.from({ length: 45 }, (_, i) => sql(
    'INSERT INTO contacts (id,workspace_id,first_name,subscribed_at) VALUES (?,?,?,?)',
    `contact-${String(i).padStart(2, '0')}`, 'a', 'Teste', 1000)))
  const first = await db.listContacts(env.DB, 'a')
  expect(first.rows).toHaveLength(40)
  expect(first.total).toBe(46)
  expect(first.next_cursor).toBeTypeOf('string')
  const second = await db.listContacts(env.DB, 'a', first.next_cursor)
  expect(second.rows).toHaveLength(6)
  expect(second.next_cursor).toBeNull()
  expect(new Set([...first.rows, ...second.rows].map(c => c.id)).size).toBe(46)
  await expect(db.listContacts(env.DB, 'b', first.next_cursor)).rejects.toMatchObject({ status: 400 })
  await expect(db.listContacts(env.DB, 'a', 'cursor inválido')).rejects.toMatchObject({ status: 400 })
})

it('FTS encontra trecho interior do nome, incluindo termos curtos e aspas sem injeção', async () => {
  expect((await db.searchContacts(env.DB, 'a', 'riana')).rows.map(c => c.id)).toEqual(['c-a'])
  expect((await db.searchContacts(env.DB, 'a', 'Olive')).rows.map(c => c.id)).toEqual(['c-a'])
  expect((await db.searchContacts(env.DB, 'a', 'Ma')).rows.map(c => c.id)).toEqual(['c-a'])
  expect((await db.searchContacts(env.DB, 'a', 'Mariana O')).rows.map(c => c.id)).toEqual(['c-a'])
  expect((await db.searchContacts(env.DB, 'a', '" OR *')).rows).toEqual([])
})

it('dedupe once é idempotente; NULL permite every_time', async () => {
  const input = { trigger_id: 'trg-a', contact_id: 'c-a', external_event_id: 'evt', dedupe_key: 'once' }
  expect(await db.recordTriggerFiring(env.DB, 'a', input)).toMatchObject({ inserted: true })
  expect(await db.recordTriggerFiring(env.DB, 'a', input)).toMatchObject({ inserted: false })
  expect(await db.recordTriggerFiring(env.DB, 'a', { ...input, dedupe_key: null })).toMatchObject({ inserted: true })
  expect(await db.recordTriggerFiring(env.DB, 'a', { ...input, dedupe_key: null })).toMatchObject({ inserted: true })
  expect(await sql('SELECT count(*) AS n FROM trigger_firings').first('n')).toBe(3)
})

it('operações válidas de tags e campos persistem e são idempotentes', async () => {
  expect(await db.tagContacts(env.DB, 'a', ['c-a'], 'tag-a')).toEqual({ count: 0 })
  expect(await db.tagContacts(env.DB, 'a', ['c-a'], 'tag-a', 'remove')).toEqual({ count: 1 })
  expect((await db.getTag(env.DB, 'a', 'tag-a'))?.contact_count).toBe(0)
  expect(await db.tagContacts(env.DB, 'a', ['c-a'], 'tag-a')).toEqual({ count: 1 })
  expect((await db.getTag(env.DB, 'a', 'tag-a'))?.contact_count).toBe(1)
  await db.setFieldValue(env.DB, 'a', 'c-a', 'field-a', 'Novo interesse')
  expect((await db.getContact(env.DB, 'a', 'c-a'))?.field_values[0]?.value).toBe('Novo interesse')
  await db.setFieldValue(env.DB, 'a', 'c-a', 'field-a', null)
  expect((await db.getContact(env.DB, 'a', 'c-a'))?.field_values).toEqual([])
  await db.deleteTag(env.DB, 'a', 'tag-a')
  expect(await db.getTag(env.DB, 'a', 'tag-a')).toBeNull()
  await db.deleteKeyword(env.DB, 'a', 'key-a')
  expect(await db.getKeyword(env.DB, 'a', 'key-a')).toBeNull()
})

it('publicação aceita campo existente e recusa campo apagado ou de outro workspace, inclusive em botão', async () => {
  const personalized = structuredClone(graph)
  personalized.nodes[1].config.blocks = [
    { kind: 'text', text: 'Olá {{primeiro_nome|cliente}}' },
    { kind: 'button', id: 'site', label: '{{campo:field-a|cliente}}', action: { type: 'url', url: 'https://example.com' } },
  ]
  await db.saveDraft(env.DB, 'a', 'auto-a', personalized)
  await expect(db.publishAutomation(env.DB, 'a', 'auto-a')).resolves.toMatchObject({ version: 1 })
  await env.DB.prepare("DELETE FROM custom_fields WHERE id='field-a'").run()
  await expect(db.publishAutomation(env.DB, 'a', 'auto-a')).rejects.toThrow(/Variável.*inexistente/)
  personalized.nodes[1].config.blocks = [{ kind: 'text', text: '{{campo:field-b|cliente}}' }]
  await db.saveDraft(env.DB, 'a', 'auto-a', personalized)
  await expect(db.publishAutomation(env.DB, 'a', 'auto-a')).rejects.toThrow(/Variável.*inexistente/)
  expect((await db.getAutomation(env.DB, 'a', 'auto-a'))?.published_version?.version).toBe(1)
})
