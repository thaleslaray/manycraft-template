import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { trashAutomation } from '../src/db/automation-library'
import { saveDraft } from '../src/db/automations'
import { authenticatedRequest as request, seedAuth } from './auth-helpers'
import { d1ComGancho } from './d1-gancho'
import { graph } from './fixtures'

let draftId: string
const aplicar = (gancho: () => unknown) => request(`email/drafts/${draftId}/automation-node`, 'a',
  { method: 'POST', body: JSON.stringify({ automationId: 'auto-a', nodeId: 'm' }) }, undefined,
  { ...env, DB: d1ComGancho(env.DB, 'UPDATE automations SET draft_graph', gancho) })
const rascunho = async () => JSON.parse((await env.DB.prepare("SELECT draft_graph FROM automations WHERE id='auto-a'").first<{ draft_graph: string }>())!.draft_graph)

beforeEach(async () => {
  await seedAuth()
  const created = await request('email/drafts', 'a', { method: 'POST', body: JSON.stringify({ name: 'Boas-vindas', subject: 'Olá', text: 'Conteúdo do e-mail', html: '<p>Oi</p>' }) })
  draftId = (await created.json() as { id: string }).id
})

describe('aplicar o e-mail num passo da automação respeita o que mudou no meio do caminho', () => {
  it('automação enviada à lixeira entre a leitura e a gravação: recusa e não mexe no rascunho dela', async () => {
    const response = await aplicar(() => trashAutomation(env.DB, 'a', 'auto-a'))
    expect(response.status).toBe(409)
    expect(await rascunho()).toEqual(graph)
  })
  it('rascunho salvo pelo editor entre a leitura e a gravação: recusa e a edição fica', async () => {
    const editado = { ...graph, nodes: graph.nodes.map(n => n.id === 'm' ? { ...n, config: { blocks: [{ kind: 'text', text: 'Editado no editor' }] } } : n) }
    const response = await aplicar(() => saveDraft(env.DB, 'a', 'auto-a', editado))
    expect(response.status).toBe(409)
    expect(await rascunho()).toEqual(editado)
  })
  it('sem nada no meio, grava o e-mail no passo escolhido', async () => {
    const response = await aplicar(() => undefined)
    expect(response.status).toBe(200)
    expect((await rascunho()).nodes.find((n: { id: string }) => n.id === 'm').config.email).toMatchObject({ subject: 'Olá', html: '<p>Oi</p>' })
  })
})
