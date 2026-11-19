import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { seed } from './fixtures'
import { validateLogicReferences } from '../src/flow/conditions'
import { validateGraph } from '../src/schemas/graph'

beforeEach(seed)

it('passo de modelo fora da janela: entra no grafo e a publicação exige modelo aprovado', async () => {
  expect(() => validateGraph({ nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'm', type: 'template_message', position: { x: 0, y: 0 }, config: { template_id: 'x' } }], edges: [{ from: 't', port: 'next', to: 'm' }] })).not.toThrow()
  await expect(validateLogicReferences(env.DB, 'a', 'template_message', { template_id: 'nao-existe' })).rejects.toThrow('aprovado')
})
