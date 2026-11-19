import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { app } from '../src/index'
import { pixelToken } from '../src/pixel'
import { deleteContacts } from '../src/contacts'
import { publishAutomation } from '../src/db/automations'
import { authenticatedRequest, origin, seedAuth } from './auth-helpers'

beforeEach(seedAuth)
const event = (body: object) => app.request(`${origin}/api/pixel/event`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://loja.example' }, body: JSON.stringify(body) }, env)

it('Pixel: script público, eventos com token assinado só com o Pixel ligado, e lista no painel', async () => {
  await env.DB.prepare("INSERT INTO contacts (id,workspace_id,first_name) VALUES ('px-c','a','Ana')").run()
  const script = await app.request(`${origin}/api/pixel.js`, {}, env)
  expect(await script.text()).toContain('fireLogMoneyEvent')
  const token = await pixelToken(env, 'a', 'px-c')
  expect((await event({ token, kind: 'conversion', name: 'compra' })).status).toBe(404)
  expect((await authenticatedRequest('pixel', 'a', { method: 'PUT', body: JSON.stringify({ enabled: true }) })).status).toBe(200)
  const ok = await event({ token, kind: 'money', amount: 49.9, currency: 'brl' })
  expect(ok.status).toBe(200)
  expect(ok.headers.get('access-control-allow-origin')).toBe('*')
  expect((await event({ token: token.replace(/.$/, c => c === '0' ? '1' : '0'), kind: 'conversion' })).status).toBe(401)
  expect((await event({ token: await pixelToken(env, 'a', 'px-c', Date.now() - 29 * 86_400_000), kind: 'conversion' })).status).toBe(401)
  const panel = await (await authenticatedRequest('pixel')).json() as { enabled: boolean; events: { kind: string; amount: number; currency: string; contact_name: string }[] }
  expect(panel).toMatchObject({ enabled: true, events: [{ kind: 'money', amount: 49.9, currency: 'BRL', contact_name: 'Ana' }] })
})

it('B5: contato apagado não grava evento do Pixel, e o link rastreado redireciona sem evento nem token novo', async () => {
  await env.DB.prepare("UPDATE workspaces SET pixel_enabled=1 WHERE id='a'").run()
  await env.DB.prepare("INSERT INTO contacts (id,workspace_id,first_name) VALUES ('px-d','a','Bia')").run()
  const token = await pixelToken(env, 'a', 'px-d')
  expect((await event({ token, kind: 'conversion', name: 'antes' })).status).toBe(200)
  const version = await publishAutomation(env.DB, 'a', 'auto-a')
  await env.DB.batch([
    env.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id,status) VALUES ('px-run','a','px-d',?,'ch-a','done')").bind(version.id),
    env.DB.prepare("INSERT INTO short_links (token,workspace_id,run_id,node_id,url,created_at) VALUES ('abcde12345','a','px-run','m','https://loja.example/oferta',1)"),
  ])
  await deleteContacts(env as never, 'a', ['px-d'])
  expect(await env.DB.prepare("SELECT status FROM contacts WHERE id='px-d'").first('status')).toBe('deleted')
  const n = () => env.DB.prepare("SELECT count(*) n FROM pixel_events WHERE contact_id='px-d'").first<number>('n')
  expect(await n()).toBe(1)
  expect((await event({ token, kind: 'conversion', name: 'depois' })).status).toBe(404)
  expect(await n()).toBe(1)
  const r = await app.request(`${origin}/api/flow-public/l/abcde12345`, {}, env)
  expect(r.status).toBe(302)
  expect(r.headers.get('location')).toBe('https://loja.example/oferta')
  expect(await env.DB.prepare("SELECT count(*) n FROM node_events WHERE contact_id='px-d'").first<number>('n')).toBe(0)
})
