import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, fixtureCookie, seedAuth } from './auth-helpers'

let cookie = ''
beforeEach(async () => { await seedAuth(); cookie = await fixtureCookie() })
const post = (body: unknown) => authenticatedRequest('quick-automations', 'a', { method: 'POST', body: JSON.stringify(body) }, cookie)

it('assistente cria a automação de palavra-chave já publicada, com mensagem, botão e gatilho ligado', async () => {
  const response = await post({ goal: 'keyword', name: 'Cupom', connection_id: 'ch-a', words: ['cupom'], message: 'Seu cupom: OFF10', button: { label: 'Usar', url: 'https://loja.test' } })
  expect(response.status).toBe(201)
  const { automation_id, trigger_id } = await response.json() as { automation_id: string; trigger_id: string }
  expect(await env.DB.prepare('SELECT status,published_version_id IS NOT NULL AS published FROM automations WHERE id=?').bind(automation_id).first()).toEqual({ status: 'live', published: 1 })
  expect(await env.DB.prepare('SELECT status,kind FROM triggers WHERE id=?').bind(trigger_id).first()).toEqual({ status: 'active', kind: 'keyword' })
  const graph = JSON.parse((await env.DB.prepare('SELECT graph FROM automation_versions WHERE automation_id=?').bind(automation_id).first<string>('graph'))!)
  expect(graph.nodes[1].config.blocks).toMatchObject([{ kind: 'text', text: 'Seu cupom: OFF10' }, { kind: 'button', label: 'Usar' }])
  expect((await post({ goal: 'keyword', name: 'x', connection_id: 'ch-a', words: [], message: 'oi' })).status).toBe(400)
})

it('menção em story com etiqueta de deduplicação: condição "não tem a etiqueta", adiciona a etiqueta e responde', async () => {
  const response = await post({ goal: 'story_mention', name: 'Obrigado pela menção', connection_id: 'ch-a', message: 'Valeu por mencionar!', dedupe_tag: 'Respondeu menção' })
  expect(response.status).toBe(201)
  const { automation_id, trigger_id } = await response.json() as { automation_id: string; trigger_id: string }
  expect(await env.DB.prepare('SELECT status,kind FROM triggers WHERE id=?').bind(trigger_id).first()).toEqual({ status: 'active', kind: 'story_mention_reply' })
  const tag = await env.DB.prepare("SELECT id FROM tags WHERE workspace_id='a' AND name='Respondeu menção'").first<string>('id')
  const graph = JSON.parse((await env.DB.prepare('SELECT graph FROM automation_versions WHERE automation_id=?').bind(automation_id).first<string>('graph'))!)
  expect(graph.nodes.map((n: { type: string }) => n.type)).toEqual(['trigger', 'condition', 'action', 'message'])
  expect(graph.nodes[1].config.rules).toEqual([{ type: 'tag', tag_id: tag, operator: 'not_has' }])
  expect(graph.edges).toContainEqual({ from: 'c1', port: 'true', to: 'a1' })
})

it('com publish=false a automação fica como rascunho e o gatilho não liga', async () => {
  const response = await post({ goal: 'keyword', name: 'Rascunho do cupom', connection_id: 'ch-a', words: ['cupom'], message: 'Seu cupom', publish: false })
  expect(response.status).toBe(201)
  const { automation_id, trigger_id } = await response.json() as { automation_id: string; trigger_id: string }
  expect(await env.DB.prepare('SELECT status,published_version_id IS NOT NULL AS published FROM automations WHERE id=?').bind(automation_id).first()).toEqual({ status: 'draft', published: 0 })
  expect(await env.DB.prepare('SELECT status FROM triggers WHERE id=?').bind(trigger_id).first<string>('status')).not.toBe('active')
  const draft = JSON.parse((await env.DB.prepare('SELECT draft_graph FROM automations WHERE id=?').bind(automation_id).first<string>('draft_graph'))!)
  expect(draft.nodes[1].config.blocks).toMatchObject([{ kind: 'text', text: 'Seu cupom' }])
})
