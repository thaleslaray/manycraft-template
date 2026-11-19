// Gerador do documento OpenAPI 3.1 a partir do catálogo (função pura: catálogo → documento).
// Usado pela rota GET /api/docs/openapi.json e pelo inventário (scripts/api-inventario.mjs), que grava .scratch/api-docs/openapi.json.
import { z } from 'zod'
import type { AreaCatalogo, EntradaCatalogo } from './tipos'

export const TAG_V1 = 'Formato ManyChat (congelada)'
type Json = Record<string, any>

const erro = (descricao: string, extra: Json = {}) => ({
  description: descricao, ...extra,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Erro' } } },
})

const componentesBase = () => ({
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', description: 'Chave de perfil: `Authorization: Bearer perfil:<chave>`. Crie em Configurações → API. Vale com as mesmas permissões que você tem no painel.' },
    chaveDoEspaco: { type: 'http', scheme: 'bearer', description: 'Chave do espaço (formato ManyChat): `Authorization: Bearer <espaço>:<segredo>`. Vale só em /api/public/v1.' },
  },
  parameters: {
    XWorkspace: { name: 'x-workspace', in: 'header', required: true, description: 'Id do espaço de trabalho em que o pedido age.', schema: { type: 'string', minLength: 1, maxLength: 128 } },
  },
  schemas: {
    Erro: { type: 'object', properties: { error: { type: 'string', description: 'Mensagem em pt-BR.' } }, required: ['error'] } as Json,
  } as Json,
  responses: {
    DadosInvalidos: erro('Dados inválidos (corpo, query ou cabeçalho fora do formato).'),
    NaoAutenticado: erro('Sem chave, chave inválida ou revogada.'),
    Proibido: erro('Sem permissão: "Esta ação só pode ser feita no painel.", "Esta chave é só de leitura." ou "Esta rota ainda não está liberada para chave."'),
    NaoEncontrado: erro('Item (ou espaço) não encontrado.'),
    TooManyRequests: erro('Limite de pedidos atingido. Espere os segundos de Retry-After.', {
      headers: { 'Retry-After': { description: 'Segundos até poder tentar de novo.', schema: { type: 'integer' } } },
    }),
  },
})

const respostasComuns = {
  400: { $ref: '#/components/responses/DadosInvalidos' },
  401: { $ref: '#/components/responses/NaoAutenticado' },
  403: { $ref: '#/components/responses/Proibido' },
  404: { $ref: '#/components/responses/NaoEncontrado' },
  429: { $ref: '#/components/responses/TooManyRequests' },
}

const idOperacao = (e: EntradaCatalogo) =>
  (e.metodo.toLowerCase() + e.caminho.replace(/^\/api/, '').replace(/[/:]+([a-zA-Z0-9_-]+)/g, (_, s: string) => '_' + s)).replace(/-/g, '_')

/** zod → JSON Schema 2020-12 (o dialeto do OpenAPI 3.1), do lado da entrada; `$defs` sobem para components.schemas. */
function esquema(schema: z.ZodType, prefixo: string, schemas: Json): Json {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' }) as Json
  delete js.$schema
  const defs = js.$defs as Json | undefined
  delete js.$defs
  if (!defs) return js
  const nome = (d: string) => `${prefixo}_${d}`
  const reescrever = (v: unknown): unknown => Array.isArray(v) ? v.map(reescrever)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) =>
      [k, k === '$ref' && typeof x === 'string' ? x.replace(/^#\/\$defs\/(.+)$/, (_, d: string) => `#/components/schemas/${nome(d)}`).replace(/^#$/, `#/components/schemas/${nome('raiz')}`) : reescrever(x)]))
    : v
  for (const [d, s] of Object.entries(defs)) schemas[nome(d)] = reescrever(s)
  const raiz = reescrever(js) as Json
  // Referência à raiz (`#`) só aparece em schema recursivo na raiz: guarda a raiz também.
  if (JSON.stringify(raiz).includes(`#/components/schemas/${nome('raiz')}"`)) schemas[nome('raiz')] = raiz
  return raiz
}

function operacao(e: EntradaCatalogo, tag: string, v1: boolean, schemas: Json): Json {
  const id = idOperacao(e)
  const parametros: Json[] = [...e.caminho.matchAll(/:([a-zA-Z0-9_]+)/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }))
  if (e.query) {
    const q = esquema(e.query, id + '_query', schemas)
    const obrigatorios = new Set<string>(q.required ?? [])
    for (const [name, schema] of Object.entries<Json>(q.properties ?? {})) {
      const { description, ...resto } = schema
      parametros.push({ name, in: 'query', required: obrigatorios.has(name), ...(description ? { description } : {}), schema: resto })
    }
  }
  if (!v1) parametros.push({ $ref: '#/components/parameters/XWorkspace' })
  const op: Json = {
    operationId: id, summary: titulo(e.resumo), tags: [tag], ...(titulo(e.resumo) !== e.resumo ? { description: e.resumo } : {}),
    ...(parametros.length ? { parameters: parametros } : {}),
    responses: {
      200: e.respostaTipo
        ? { description: 'Sucesso.', content: { [e.respostaTipo]: { schema: { type: 'string', format: 'binary' } } } }
        : { description: 'Sucesso.', content: { 'application/json': { schema: {} } } },
      ...respostasComuns,
    },
  }
  if (v1) op.security = [{ chaveDoEspaco: [] }]
  if (e.corpoBinario) op.requestBody = { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }
  if (e.corpo || e.corpoDoc) op.requestBody = { required: true, content: { 'application/json': { schema: esquema((e.corpoDoc ?? e.corpo)!, id + '_corpo', schemas), ...(e.exemplo !== undefined ? { example: e.exemplo } : {}) } } }
  return op
}

export function gerarOpenApi({ areas, v1 }: { areas: AreaCatalogo[]; v1: AreaCatalogo }): Json {
  const components = componentesBase()
  const paths: Json = {}
  const incluir = (e: EntradaCatalogo, tag: string, ehV1: boolean) => {
    if (e.soDesenvolvimento) return
    const caminho = e.caminho.replace(/:([a-zA-Z0-9_]+)/g, '{$1}')
    ;(paths[caminho] ??= {})[e.metodo.toLowerCase()] = operacao(e, tag, ehV1, components.schemas)
  }
  const ordenadas = [...areas].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
  for (const area of ordenadas) for (const e of area.entradas) incluir(e, area.nome, false)
  for (const e of v1.entradas) incluir(e, TAG_V1, true)
  return {
    openapi: '3.1.0',
    info: {
      title: 'API do ManyCraft',
      version: '1.0.0',
      description: 'As mesmas rotas do painel, por chave de perfil (`Authorization: Bearer perfil:<chave>` + cabeçalho `x-workspace`), com as permissões que você tem no painel. Rotas que só podem ser feitas no painel ficam de fora. A seção "Formato ManyChat (congelada)" usa a chave do espaço e não muda mais.',
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }],
    tags: [...ordenadas.filter(a => a.entradas.some(e => !e.soDesenvolvimento)).map(a => ({ name: a.nome, description: a.descricao })), { name: TAG_V1, description: 'Compatível com a API pública do ManyChat. Congelada: não recebe rotas novas.' }],
    paths,
    components,
  }
}

/**
 * Título da operação (o `summary`, que a página mostra como texto puro, sem markdown): a primeira frase do resumo (até ponto, dois-pontos ou ponto e vírgula), sem os
 * trechos entre parênteses e sem crases, cortada na última vírgula antes de 80 caracteres (sem vírgula, aceita até 110; acima disso corta numa palavra, com reticências). O resumo inteiro vai para a `description`.
 */
export function titulo(resumo: string): string {
  let frase = resumo, dentro = false, parenteses = 0
  for (let i = 0; i < resumo.length; i++) {
    if (resumo[i] === '`') dentro = !dentro
    else if (!dentro && resumo[i] === '(') parenteses++
    else if (!dentro && resumo[i] === ')') parenteses = Math.max(0, parenteses - 1)
    else if (!dentro && parenteses === 0 && (resumo[i] === '.' || resumo[i] === ':' || resumo[i] === ';') && (i === resumo.length - 1 || resumo[i + 1] === ' ')) { frase = resumo.slice(0, i + 1); break }
  }
  let limpo = frase.replace(/\s*\([^()]*\)/g, '').replace(/`/g, '').replace(/\s+([,.:])/g, '$1').replace(/[:;]$/, '.').trim()
  if (limpo.length > 80) {
    const virgula = limpo.lastIndexOf(',', 80)
    limpo = virgula > 30 ? limpo.slice(0, virgula) + '.' : limpo.length <= 110 ? limpo : limpo.slice(0, 109).replace(/\s+\S*$/, '').replace(/[,;:]$/, '') + '…'
  }
  return limpo
}
