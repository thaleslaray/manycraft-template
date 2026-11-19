import { expect, it } from 'vitest'
import { z } from 'zod'
import { gerarOpenApi } from '../src/api-docs/gerar'
import type { AreaCatalogo } from '../src/api-docs/tipos'

const corpo = z.object({ nome: z.string().max(60), idade: z.number().int().optional() }).strict()
const areas: AreaCatalogo[] = [{ area: 'contacts', nome: 'Contatos', descricao: 'Os contatos do espaço.', entradas: [
  { metodo: 'PATCH', caminho: '/api/contacts/:id', resumo: 'Altera o contato.', corpo, exemplo: { nome: 'Ana' } },
  { metodo: 'GET', caminho: '/api/contacts', resumo: 'Lista os contatos.', query: z.object({ cursor: z.string().optional(), status: z.enum(['a', 'b']).optional() }) },
] }]
const v1: AreaCatalogo = { area: 'public-v1', nome: 'v1', descricao: 'v1', entradas: [{ metodo: 'GET', caminho: '/api/public/v1/page/getInfo', resumo: 'Dados da conta.' }] }

it('gera OpenAPI 3.1 com caminho em chaves, parâmetro de caminho, corpo do zod e exemplo', () => {
  const doc = gerarOpenApi({ areas, v1 }) as any
  expect(doc.openapi).toBe('3.1.0')
  const op = doc.paths['/api/contacts/{id}'].patch
  expect(op.summary).toBe('Altera o contato.')
  expect(op.tags).toEqual(['Contatos'])
  expect(doc.tags).toContainEqual({ name: 'Contatos', description: 'Os contatos do espaço.' })
  expect(op.parameters).toContainEqual({ name: 'id', in: 'path', required: true, schema: { type: 'string' } })
  expect(op.parameters).toContainEqual({ $ref: '#/components/parameters/XWorkspace' })
  const schema = op.requestBody.content['application/json'].schema
  expect(schema).toMatchObject({ type: 'object', required: ['nome'], additionalProperties: false, properties: { nome: { type: 'string', maxLength: 60 }, idade: { type: 'integer' } } })
  expect(schema.$schema).toBeUndefined()
  expect(op.requestBody.content['application/json'].example).toEqual({ nome: 'Ana' })
})

it('query vira parâmetros in=query e as respostas de erro comuns entram por referência', () => {
  const doc = gerarOpenApi({ areas, v1 }) as any
  const op = doc.paths['/api/contacts'].get
  expect(op.parameters).toContainEqual({ name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['a', 'b'] } })
  expect(op.requestBody).toBeUndefined()
  for (const s of ['400', '401', '403', '404', '429']) expect(op.responses[s].$ref).toMatch(/^#\/components\/responses\//)
  expect(doc.components.responses.TooManyRequests.headers['Retry-After']).toBeDefined()
  expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' })
  expect(doc.security).toEqual([{ bearerAuth: [] }])
})

it('a seção v1 é separada (congelada), com a chave do espaço e sem x-workspace', () => {
  const doc = gerarOpenApi({ areas, v1 }) as any
  const op = doc.paths['/api/public/v1/page/getInfo'].get
  expect(op.tags).toEqual(['Formato ManyChat (congelada)'])
  expect(op.security).toEqual([{ chaveDoEspaco: [] }])
  expect(op.parameters ?? []).not.toContainEqual({ $ref: '#/components/parameters/XWorkspace' })
})

it('schema recursivo leva as definições para components.schemas', () => {
  type No = { filhos: No[] }
  const no: z.ZodType<No> = z.lazy(() => z.object({ filhos: z.array(no) }))
  const doc = gerarOpenApi({ areas: [{ area: 'x', nome: 'X', descricao: 'X.', entradas: [{ metodo: 'POST', caminho: '/api/x', resumo: 'R.', corpo: z.object({ raiz: no }) }] }], v1 }) as any
  const texto = JSON.stringify(doc)
  expect(texto).not.toContain('#/$defs/')
  const refs = [...texto.matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map(m => m[1])
  expect(refs.length).toBeGreaterThan(0)
  for (const r of refs) expect(doc.components.schemas[r!]).toBeDefined()
})

it('rota só de desenvolvimento fica fora do documento', () => {
  const doc = gerarOpenApi({ areas: [{ area: 'email', nome: 'E-mail', descricao: 'E.', entradas: [
    { metodo: 'GET', caminho: '/api/email/settings', resumo: 'R.' },
    { metodo: 'GET', caminho: '/api/email/dev/outbox', resumo: 'R.', soDesenvolvimento: true },
  ] }], v1 }) as any
  expect(doc.paths['/api/email/settings']).toBeDefined()
  expect(doc.paths['/api/email/dev/outbox']).toBeUndefined()
})

it('corpo binário vira application/octet-stream', () => {
  const doc = gerarOpenApi({ areas: [{ area: 'media', nome: 'Mídia', descricao: 'M.', entradas: [{ metodo: 'POST', caminho: '/api/media', resumo: 'R.', corpoBinario: true }] }], v1 }) as any
  expect(doc.paths['/api/media'].post.requestBody.content['application/octet-stream'].schema).toEqual({ type: 'string', format: 'binary' })
})

it('título da operação é a primeira frase, sem crases nem parênteses; o texto inteiro vai para a descrição', () => {
  const resumo = 'Envia mensagens a quem chegou por link ou plugin (`user_ref`) numa conexão (`channel_id`), criando o contato se preciso. O `data` segue o formato `{ "version": "v2" }`.'
  const doc = gerarOpenApi({ areas: [{ area: 'x', nome: 'X', descricao: 'X.', entradas: [
    { metodo: 'POST', caminho: '/api/x', resumo },
    { metodo: 'GET', caminho: '/api/y', resumo: 'Lista os contatos.' },
  ] }], v1 }) as any
  const op = doc.paths['/api/x'].post
  expect(op.summary).not.toMatch(/[`(){}]/)
  expect(op.summary.length).toBeLessThanOrEqual(110)
  expect(op.summary.startsWith('Envia mensagens a quem chegou por link ou plugin numa conexão')).toBe(true)
  expect(op.description).toBe(resumo)
  expect(doc.paths['/api/y'].get.summary).toBe('Lista os contatos.')
  expect(doc.paths['/api/y'].get.description).toBeUndefined()
})

it('título não corta frase em ponto ou dois-pontos dentro de parênteses nem de crases', () => {
  const doc = gerarOpenApi({ areas: [{ area: 'x', nome: 'X', descricao: 'X.', entradas: [
    { metodo: 'GET', caminho: '/api/a', resumo: 'Lista as tags ativas (`data`: lista de { id, name }). Ordem alfabética.' },
    { metodo: 'GET', caminho: '/api/b', resumo: 'Troca as credenciais da conexão (ex.: token novo).' },
  ] }], v1 }) as any
  expect(doc.paths['/api/a'].get.summary).toBe('Lista as tags ativas.')
  expect(doc.paths['/api/b'].get.summary).toBe('Troca as credenciais da conexão.')
})
