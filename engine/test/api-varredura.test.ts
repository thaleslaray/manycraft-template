import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import { documentoOpenApi } from '../src/api-docs/rotas'
import { authenticatedRequest, fixtureCookie, origin, seedAuth } from './auth-helpers'

// Varredura (.scratch/api-varredura/spec.md): cada operação do documento OpenAPI é pedida por chave, com o exemplo
// da própria documentação. Nunca 500; com exemplo, nunca 400 "Dados inválidos"; GET por chave = GET por cookie.
// Sem rede: todo fetch para fora responde um 200 genérico (nenhum provedor de verdade é chamado).

/** Operações que o teste não exerce, com o motivo. Operação nova no documento sem passar aqui é exercida. */
const FORA: Record<string, string> = {
}
/** GET cujo corpo muda entre dois pedidos seguidos (relógio, contadores de uso): compara só o status. */
const CORPO_INSTAVEL = new Set<string>([
  'GET /api/dashboard', // reference_at é o relógio do pedido
])
/** Query extra por operação (opcional no documento), para exercer o caminho útil em vez de um 503 de configuração. */
const QUERY_EXTRA: Record<string, string> = { 'POST /api/media': 'purpose=account_photo' }
/** Escritas que apagam dados do seed (contato c-a): vão por último de tudo. */
const APAGA_SEED = /\/(bulk-delete|merge|cleanup)$/

type Op = { metodo: string; caminho: string; exemplo?: unknown; temCorpo: boolean; binario: boolean; query: { name: string; required: boolean; schema: any }[] }
const doc = JSON.parse(documentoOpenApi()) as { paths: Record<string, Record<string, any>> }
const ops: Op[] = Object.entries(doc.paths).flatMap(([caminho, metodos]) => Object.entries(metodos).map(([m, op]) => ({
  metodo: m.toUpperCase(), caminho,
  exemplo: op.requestBody?.content?.['application/json']?.example,
  temCorpo: !!op.requestBody, binario: !!op.requestBody?.content?.['application/octet-stream'],
  query: (op.parameters ?? []).filter((p: any) => p.in === 'query'),
})))
const chave = (o: { metodo: string; caminho: string }) => `${o.metodo} ${o.caminho}`

// Ids dos dados do seed (test/fixtures.ts) por nome de parâmetro e área; o resto vem do id que o POST da coleção devolveu.
const criados = new Map<string, string>()
function valorParametro(caminho: string, nome: string): string {
  const base = caminho.slice(0, caminho.indexOf(`{${nome}}`) - 1)
  if (criados.has(base)) return criados.get(base)!
  const fixo: Record<string, string> = { triggerId: 'trg-a', connection: 'ch-a', contactId: 'c-a', fieldId: 'field-a', kind: 'default_reply', name: 'index.js', sequence: 'seq-varredura' }
  if (fixo[nome]) return caminho.includes('/surfaces/') && nome === 'kind' ? 'conversation_starters' : fixo[nome]
  const porArea: [RegExp, string][] = [[/^\/api\/automations$/, 'auto-a'], [/^\/api\/contacts$|^\/api\/email\/contacts$/, 'c-a'], [/^\/api\/tags$/, 'tag-a'],
    [/^\/api\/fields$/, 'field-a'], [/^\/api\/keywords$/, 'key-a'], [/^\/api\/triggers$/, 'trg-a'], [/connections$/, 'ch-a'], [/^\/api\/inbox\/conversations$/, 'conv-varredura']]
  return porArea.find(([re]) => re.test(base))?.[1] ?? 'inexistente'
}
function montar(o: Op) {
  const caminho = o.caminho.replace(/\{(\w+)\}/g, (_, n: string) => encodeURIComponent(valorParametro(o.caminho, n)))
  const q = new URLSearchParams()
  const porNome: Record<string, string> = { subscriber_id: 'c-a', field_id: 'field-a', field_value: 'Curso', name: 'Mariana Oliveira', user_ref: 'user-a', channel_id: 'ch-a', tag: 'tag-a' }
  for (const p of o.query) if (p.required) q.set(p.name, String(porNome[p.name] ?? p.schema?.example ?? p.schema?.enum?.[0] ?? p.schema?.default ?? 'varredura'))
  for (const [k, v] of new URLSearchParams(QUERY_EXTRA[chave(o)] ?? '')) q.set(k, v)
  return caminho.replace(/^\/api\//, '') + (q.size ? `?${q}` : '')
}

// Os exemplos da documentação usam ids ilustrativos (`c1`, `tag-cliente`, `auto-1`): troca pelos ids reais do teste.
function idReal(v: string): string {
  if (/^c1$/.test(v)) return 'c-a'
  if (/^c2$/.test(v)) return 'c-a2'
  if (/^(t1|tag-.*)$/.test(v)) return 'tag-a'
  if (/^auto-/.test(v)) return 'auto-a'
  if (/^(campo-.*|f-.*)$/.test(v)) return 'field-a'
  if (/^(ch-.*|conn-.*|canal-.*)$/.test(v)) return 'ch-a'
  if (/^seq-/.test(v)) return 'seq-varredura'
  if (v === 'membro-1') return 'member-a'
  if (v === 'etiqueta-vip') return criados.get('/api/inbox/labels') ?? v
  return v
}
function comIdsReais(v: unknown, k = ''): unknown {
  if (Array.isArray(v)) return v.map(x => comIdsReais(x, k))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([a, b]) => [a, comIdsReais(b, a)]))
  return typeof v === 'string' && /(^|_)id$|_ids$|^ids$|^flow_ns$/.test(k) ? idReal(v) : v
}

const LOG = false // true imprime status e começo da resposta de cada operação (rode com --silent=false)
let cookie = ''
let tokens: string[] = []
let espacoToken = ''
let pedidosNaChave = 0
async function novaChave() {
  const r = await authenticatedRequest('profile/api-key', 'a', { method: 'POST', body: JSON.stringify({ name: `Varredura ${tokens.length}`, scope: 'write' }) }, cookie)
  tokens.push(((await r.json()) as { token: string }).token)
  pedidosNaChave = 0
}
async function porChave(o: Op, caminho: string) {
  // O limite é 600/min por chave: troca de chave antes de chegar perto, sem afrouxar o limite.
  if (pedidosNaChave >= 500) await novaChave()
  pedidosNaChave++
  const v1 = o.caminho.startsWith('/api/public/v1/')
  const headers: Record<string, string> = { authorization: `Bearer ${v1 ? espacoToken : tokens.at(-1)}` }
  if (!v1) headers['x-workspace'] = 'a'
  let body: BodyInit | undefined
  if (o.binario) { headers['content-type'] = 'image/png'; headers['content-length'] = '8'; body = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }
  else if (o.temCorpo) { headers['content-type'] = 'application/json'; body = JSON.stringify(comIdsReais(o.exemplo ?? {})) }
  return app.request(`${origin}/api/${caminho}`, { method: o.metodo, headers, body }, env)
}

let rede: ReturnType<typeof vi.spyOn>
beforeAll(async () => {
  rede = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: {}, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
  await seedAuth()
  await env.DB.prepare("UPDATE channels SET type='telegram' WHERE id='ch-a'").run()
  await env.DB.prepare("INSERT INTO sequences(id,workspace_id,name) VALUES('seq-varredura','a','Nutrição')").run()
  await env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name,subscribed_at) VALUES('c-a2','a','Paula',1000)").run()
  await env.DB.prepare("INSERT INTO conversations(id,workspace_id,contact_channel_id) VALUES('conv-varredura','a','cc-a')").run()
  cookie = await fixtureCookie('a')
  await novaChave()
  espacoToken = ((await (await authenticatedRequest('api-keys', 'a', { method: 'POST' }, cookie)).json()) as { token: string }).token
})
afterAll(() => rede.mockRestore())

it('toda operação do documento OpenAPI, por chave: nunca 500, exemplo nunca inválido, GET igual ao cookie', { timeout: 120_000 }, async () => {
  const caminhos = new Set(ops.map(chave))
  expect(Object.keys(FORA).filter(k => !caminhos.has(k)), 'entrada da lista que não existe mais no documento').toEqual([])
  const exercidas = ops.filter(o => !FORA[chave(o)])
  // Ordem: leituras, criações na raiz da área (guardam o id), demais escritas, apagamentos por último.
  const fase = (o: Op) => APAGA_SEED.test(o.caminho) ? 4 : o.metodo === 'GET' ? 0 : o.metodo === 'DELETE' ? 3 : o.metodo === 'POST' && !o.caminho.includes('{') ? 1 : 2
  const ordem = [...exercidas].sort((a, b) => fase(a) - fase(b))
  const defeitos: string[] = []
  for (const o of ordem) {
    const caminho = montar(o)
    const r = await porChave(o, caminho)
    const texto = await r.text()
    const nome = `${chave(o)} (${caminho}) → ${r.status}`
    if (LOG) console.log(`[op] ${r.status} ${chave(o)} ${caminho} ${texto.slice(0, 160)}`)
    if (r.status >= 500) defeitos.push(`${nome}: 500 ${texto.slice(0, 200)}`)
    if (o.exemplo !== undefined && r.status === 400 && texto.includes('Dados inválidos')) defeitos.push(`${nome}: exemplo inválido ${texto.slice(0, 300)}`)
    // Sem corpo no documento, o pedido sem corpo tem de ser aceito; GET com a query obrigatória documentada não pode ser "inválido".
    if (!o.temCorpo && r.status === 400 && texto.includes('JSON inválido')) defeitos.push(`${nome}: exige corpo que o documento não declara`)
    if (o.metodo === 'GET' && r.status === 400 && /Dados inválidos|Parâmetros inválidos/.test(texto) && !/\{id\}/.test(o.caminho)) defeitos.push(`${nome}: query obrigatória fora do documento ${texto.slice(0, 200)}`)
    if (o.metodo === 'POST' && !o.caminho.includes('{') && r.status < 300) {
      try { const j = JSON.parse(texto); const id = j?.id ?? j?.item?.id ?? j?.data?.id; if (typeof id === 'string' || typeof id === 'number') criados.set(o.caminho, String(id)) } catch {}
    }
    if (o.metodo === 'GET' && !o.caminho.startsWith('/api/public/v1/')) {
      const c = await authenticatedRequest(caminho, 'a', {}, cookie)
      const textoCookie = await c.text()
      if (c.status !== r.status) defeitos.push(`${nome}: cookie deu ${c.status}`)
      else if (!CORPO_INSTAVEL.has(chave(o)) && textoCookie !== texto) defeitos.push(`${nome}: corpo difere do cookie`)
    }
  }
  const porMotivo = Object.values(FORA).reduce<Record<string, number>>((acc, m) => ({ ...acc, [m]: (acc[m] ?? 0) + 1 }), {})
  console.log(`[varredura] exercidas ${exercidas.length}, na lista ${Object.keys(FORA).length}`, porMotivo)
  expect(defeitos).toEqual([])
})
