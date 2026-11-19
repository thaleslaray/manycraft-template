import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Env } from '../src/env'
import { authenticatedRequest, seedAuth } from './auth-helpers'

// Erro inesperado (fora de HTTPException, ZodError e dos 400/404/409 de domínio): o cliente recebe a frase genérica e o log
// `api_error` leva o caminho mascarado (ids e tokens viram :id), nunca o identificador cru.
beforeEach(seedAuth)
afterEach(() => { vi.restoreAllMocks() })

it('log api_error mascara o id do caminho e a resposta não mostra o erro', async () => {
  const id = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
  // Banco que falha só nas leituras de automação: a sessão passa e a rota da automação estoura com um erro comum.
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'prepare') return (sql: string) => { if (/FROM automations/.test(sql)) throw new Error('D1_ERROR: falha simulada'); return target.prepare(sql) }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const response = await authenticatedRequest(`automations/${id}`, 'a', {}, undefined, { ...env, DB: db } as Env)
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ error: 'Não foi possível concluir a operação.' })
  const calls = log.mock.calls.filter(([tag]) => tag === 'api_error')
  expect(calls).toHaveLength(1)
  expect(calls[0][1]).toMatchObject({ name: 'Error', path: '/api/automations/:id', message: 'D1_ERROR: falha simulada' })
  expect(JSON.stringify(log.mock.calls)).not.toContain(id)
})
