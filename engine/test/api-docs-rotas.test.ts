import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { app } from '../src/index'

const get = (path: string) => app.request(`https://engine.test${path}`, {}, env)

it('GET /api/docs é público e carrega o Scalar pinado (1.80.0) apontando para o openapi.json', async () => {
  const res = await get('/api/docs')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toMatch(/text\/html/)
  const html = await res.text()
  expect(html).toContain('https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.80.0')
  expect(html).toContain('/api/docs/openapi.json')
  expect(res.headers.get('content-security-policy')).toContain('https://cdn.jsdelivr.net')
})

it('GET /api/docs/openapi.json é público e traz os contatos e a seção v1, sem rota só do painel', async () => {
  const res = await get('/api/docs/openapi.json')
  expect(res.status).toBe(200)
  const doc = await res.json() as { openapi: string; paths: Record<string, Record<string, { tags: string[]; requestBody?: unknown }>> }
  expect(doc.openapi).toBe('3.1.0')
  expect(doc.paths['/api/contacts/{id}']!.patch!.requestBody).toBeDefined()
  expect(doc.paths['/api/public/v1/page/getInfo']!.get!.tags).toEqual(['Formato ManyChat (congelada)'])
  expect(Object.keys(doc.paths).some(p => p.startsWith('/api/api-keys') || p.startsWith('/api/profile'))).toBe(false)
})
