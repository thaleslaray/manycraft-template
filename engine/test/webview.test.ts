import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { app } from '../src/index'
import { seed } from './fixtures'

beforeEach(seed)
it('webview: o passo publicado abre como página, escapando o texto', async () => {
  const graph = { nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'm', type: 'message', position: { x: 0, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Oferta <b>boa</b>' }, { kind: 'button', id: 'b', label: 'Comprar', action: { type: 'url', url: 'https://loja.example' } }] } }], edges: [] }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('wv','a','auto-a',9,?)").bind(JSON.stringify(graph)),
    env.DB.prepare("UPDATE automations SET published_version_id='wv' WHERE id='auto-a'"),
  ])
  const r = await app.request('https://engine.test/api/flow-public/webview/auto-a/m', {}, env)
  const html = await r.text()
  expect(r.status).toBe(200)
  expect(html).toContain('Oferta &lt;b&gt;boa&lt;/b&gt;')
  expect(html).toContain('href="https://loja.example"')
  expect((await app.request('https://engine.test/api/flow-public/webview/auto-a/nada', {}, env)).status).toBe(404)
})
