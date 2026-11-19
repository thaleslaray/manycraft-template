import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest as request, seedAuth } from './auth-helpers'
import { graphSchema } from '../src/schemas/graph'
import { automationDraftSchema } from '../src/automation-actions'
import { automationDraftDocSchema, rascunhoExemplo, tiposDePassoDoc, tiposDeBlocoDoc } from '../src/api-docs/rascunho'
import { gerarOpenApi } from '../src/api-docs/gerar'
import { AREAS as areas, v1 } from '../src/api-docs/catalogo'

beforeEach(seedAuth)

it('o exemplo do rascunho passa no graphSchema e no schema de documentação', () => {
  expect(() => graphSchema.parse(rascunhoExemplo.graph)).not.toThrow()
  expect(automationDraftDocSchema.safeParse(rascunhoExemplo).success).toBe(true)
  // A rota continua aceitando o mesmo de antes (graph livre).
  expect(automationDraftSchema.safeParse({ graph: 1 }).success).toBe(true)
})

it('o documento descreve cada tipo de passo e de bloco com título em pt-BR, e o exemplo vem junto', () => {
  const doc = gerarOpenApi({ areas, v1 }) as any
  const body = doc.paths['/api/automations/{id}/draft'].put.requestBody.content['application/json']
  expect(body.example).toEqual(rascunhoExemplo)
  const texto = JSON.stringify(doc)
  expect(body.schema.properties.graph).toBeDefined()
  expect(JSON.stringify(body.schema.properties.graph)).not.toBe('{}')
  for (const t of [...tiposDePassoDoc, ...tiposDeBlocoDoc]) expect(texto, t).toContain(`"title":"${t}"`)
  expect(tiposDePassoDoc.length).toBeGreaterThanOrEqual(10)
  expect(body.schema.description ?? doc.paths['/api/automations/{id}/draft'].put.description).toMatch(/publicar/i)
})

it('o exemplo salva como rascunho e publica de verdade', async () => {
  const graph = JSON.parse(JSON.stringify(rascunhoExemplo.graph).replaceAll('campo-interesse', 'field-a'))
  expect((await request('automations/auto-a/draft', 'a', { method: 'PUT', body: JSON.stringify({ graph }) })).status).toBe(200)
  const publish = await request('automations/auto-a/publish', 'a', { method: 'POST' })
  expect(publish.status, await publish.clone().text()).toBe(201)
})

it('o formato do fluxo é conferido ao salvar: grafo fora do formato volta 400', async () => {
  const response = await request('automations/auto-a/draft', 'a', { method: 'PUT', body: JSON.stringify({ graph: { nodes: [{ id: 'x', type: 'inexistente' }], edges: [] } }) })
  expect(response.status).toBe(400)
})
