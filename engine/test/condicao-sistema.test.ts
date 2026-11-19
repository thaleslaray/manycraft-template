import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { seed, graph } from './fixtures'
import { condition } from '../src/flow/nodes'
import { publishAutomation } from '../src/db/automations'
import { queryFilteredContacts } from '../src/db/contact-filter'
import { savedSegmentSql } from '../src/email-channel/filters'

const run: any = { id: 'run-sistema', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', automation_id: 'auto-a' }
const regra = (field: string, operator: string, value?: unknown) => ({ match: 'all', rules: [{ type: 'system_field', field, operator, ...(value === undefined ? {} : { value }) }] })
const ok = async (field: string, operator: string, value?: unknown) => (await condition(env, run, regra(field, operator, value))) === 'true'

beforeEach(async () => {
  await seed()
  await env.DB.prepare("UPDATE contacts SET phone='5511987654321', locale='pt_BR', timezone='America/Sao_Paulo', last_input_text='Quero o Curso de Inverno' WHERE id='c-a'").run()
})

it('telefone: existe, não existe e começa com (só dígitos)', async () => {
  expect(await ok('phone', 'is_set')).toBe(true)
  expect(await ok('phone', 'is_not_set')).toBe(false)
  expect(await ok('phone', 'starts_with', '5511')).toBe(true)
  expect(await ok('phone', 'starts_with', '+55 (11) 98')).toBe(true)
  expect(await ok('phone', 'starts_with', '5521')).toBe(false)
  await env.DB.prepare("UPDATE contacts SET phone=NULL WHERE id='c-a'").run()
  expect(await ok('phone', 'is_set')).toBe(false)
  expect(await ok('phone', 'is_not_set')).toBe(true)
  expect(await ok('phone', 'starts_with', '55')).toBe(false)
})
it('idioma e fuso: é e não é, sem diferenciar maiúsculas', async () => {
  expect(await ok('locale', 'equals', 'pt_BR')).toBe(true)
  expect(await ok('locale', 'equals', 'PT_br')).toBe(true)
  expect(await ok('locale', 'not_equals', 'en_US')).toBe(true)
  expect(await ok('locale', 'not_equals', 'pt_BR')).toBe(false)
  expect(await ok('timezone', 'equals', 'America/Sao_Paulo')).toBe(true)
  expect(await ok('timezone', 'not_equals', 'America/Sao_Paulo')).toBe(false)
  await env.DB.prepare("UPDATE contacts SET locale=NULL WHERE id='c-a'").run()
  expect(await ok('locale', 'equals', 'pt_BR')).toBe(false)
  expect(await ok('locale', 'not_equals', 'pt_BR')).toBe(true)
})
it('última mensagem: contém e não contém', async () => {
  expect(await ok('last_input_text', 'contains', 'curso')).toBe(true)
  expect(await ok('last_input_text', 'contains', 'verão')).toBe(false)
  expect(await ok('last_input_text', 'not_contains', 'verão')).toBe(true)
  expect(await ok('last_input_text', 'not_contains', 'INVERNO')).toBe(false)
  await env.DB.prepare("UPDATE contacts SET last_input_text=NULL WHERE id='c-a'").run()
  expect(await ok('last_input_text', 'contains', 'curso')).toBe(false)
  expect(await ok('last_input_text', 'not_contains', 'curso')).toBe(true)
})
it('ID do contato: é e não é, exato', async () => {
  expect(await ok('contact_id', 'equals', 'c-a')).toBe(true)
  expect(await ok('contact_id', 'equals', 'C-A')).toBe(false)
  expect(await ok('contact_id', 'not_equals', 'c-b')).toBe(true)
  expect(await ok('contact_id', 'not_equals', 'c-a')).toBe(false)
})
it('operador fora do que o dado aceita é recusado', async () => {
  await expect(condition(env, run, regra('contact_id', 'starts_with', 'c-'))).rejects.toThrow()
  await expect(condition(env, run, regra('phone', 'starts_with', ''))).rejects.toThrow()
  await expect(condition(env, run, regra('locale', 'gt', 3))).rejects.toThrow()
})
it('o filtro de contatos usa a mesma regra que o fluxo', async () => {
  const filtro = (field: string, operator: string, value?: unknown) => ({ match: 'all', rules: [{ type: 'system', field, operator, ...(value === undefined ? {} : { value }) }] })
  const total = async (f: unknown) => (await queryFilteredContacts(env.DB, 'a', f)).total
  expect(await total(filtro('phone', 'starts_with', '5511'))).toBe(1)
  expect(await total(filtro('phone', 'starts_with', '5521'))).toBe(0)
  expect(await total(filtro('phone', 'is_not_set'))).toBe(0)
  expect(await total(filtro('locale', 'equals', 'PT_br'))).toBe(1)
  expect(await total(filtro('timezone', 'not_equals', 'America/Sao_Paulo'))).toBe(0)
  expect(await total(filtro('last_input_text', 'not_contains', 'verão'))).toBe(1)
  expect(await total(filtro('last_input_text', 'contains', 'INVERNO'))).toBe(1)
  expect(await total(filtro('contact_id', 'equals', 'c-a'))).toBe(1)
  expect(await total(filtro('contact_id', 'not_equals', 'c-a'))).toBe(0)
  // Segmento salvo no formato de condição de sistema também avalia igual.
  await env.DB.prepare("INSERT INTO segments(id,workspace_id,name,filter) VALUES ('seg-sis','a','Telefone BR',?)").bind(JSON.stringify(regra('phone', 'starts_with', '55'))).run()
  const seg = await savedSegmentSql(env.DB, 'a', 'seg-sis')
  expect((await env.DB.prepare(`SELECT count(*) AS n FROM contacts c WHERE c.workspace_id='a' AND ${seg.sql}`).bind(...seg.values).first<{ n: number }>())?.n).toBe(1)
})
it('publicação aceita as regras de sistema e recusa dado desconhecido', async () => {
  const publicar = async (config: unknown) => {
    const draft = { nodes: [...graph.nodes, { id: 'logic', type: 'condition', position: { x: 0, y: 0 }, config }], edges: [...graph.edges, { from: 'm', port: 'next', to: 'logic' }] }
    await env.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(JSON.stringify(draft)).run()
    return publishAutomation(env.DB, 'a', 'auto-a')
  }
  await expect(publicar(regra('locale', 'equals', 'pt_BR'))).resolves.toBeDefined()
  await expect(publicar(regra('segue_instagram', 'equals', true))).rejects.toThrow()
})
