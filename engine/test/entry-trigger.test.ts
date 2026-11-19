import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

beforeEach(seedAuth)
const NOW = Date.now()
const firing = (trigger: string, contact: string, key: string, at = NOW) =>
  env.DB.prepare('INSERT INTO trigger_firings(workspace_id,trigger_id,contact_id,external_event_id,dedupe_key,fired_at) VALUES (?,?,?,?,?,?)').bind('a', trigger, contact, `ev-${key}`, key, at).run()
const source = async (id: string) => (await env.DB.prepare('SELECT optin_source AS s FROM contacts WHERE id=?').bind(id).first<{ s: string | null }>())?.s

async function seedContacts() {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind) VALUES ('t2','a','auto-a','ch-a','Segundo','keyword')"),
    env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name,optin_source,created_at) VALUES ('n1','a','Novo','telegram',?)").bind(NOW),
    env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name,optin_source,created_at) VALUES ('n2','a','Sem origem',NULL,?)").bind(NOW),
    env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name,optin_source,created_at) VALUES ('api1','a','Da API','api',?)").bind(NOW),
    env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name,optin_source,created_at) VALUES ('old','a','Antigo','telegram',?)").bind(NOW - 3 * 86400000),
  ])
}

it('grava o primeiro gatilho num contato novo e nunca sobrescreve', async () => {
  await seedContacts()
  await firing('trg-a', 'n1', 'k1')
  expect(await source('n1')).toBe('trigger:trg-a')
  await firing('t2', 'n1', 'k2')
  expect(await source('n1')).toBe('trigger:trg-a')
  await firing('t2', 'n2', 'k3')
  expect(await source('n2')).toBe('trigger:t2')
})

it('não inventa gatilho para contato antigo nem troca origem explícita', async () => {
  await seedContacts()
  await firing('trg-a', 'old', 'k1')
  await firing('trg-a', 'api1', 'k2')
  expect(await source('old')).toBe('telegram')
  expect(await source('api1')).toBe('api')
})

it('a lateral conta o gatilho e a consulta por segmento filtra pelo gatilho de entrada', async () => {
  await seedContacts()
  await firing('trg-a', 'n1', 'k1')
  await firing('t2', 'n2', 'k2')
  const facets = await (await authenticatedRequest('contact-facets')).json() as { triggers: { id: string; count: number }[] }
  expect(facets.triggers.find(t => t.id === 'trg-a')?.count).toBe(1)
  const query = async (operator: string) => {
    const response = await authenticatedRequest('contacts/query', 'a', { method: 'POST', body: JSON.stringify({ filter: { match: 'all', rules: [{ type: 'entry_trigger', trigger_id: 'trg-a', operator }] } }) })
    expect(response.status).toBe(200)
    return ((await response.json()) as { rows: { id: string }[] }).rows.map(r => r.id)
  }
  expect(await query('entered_by')).toEqual(['n1'])
  const other = await query('not_entered_by')
  expect(other).toContain('n2')
  expect(other).not.toContain('n1')
})
