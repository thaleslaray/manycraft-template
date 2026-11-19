/**
 * Harness da jornada "usuário novo de ponta a ponta". Cada elo roda por trás de `elo()`: se falhar, o teste fica vermelho
 * com o nome do elo, e o resultado vai para `task.meta.elos`, de onde o relatório sai.
 */
import { env } from 'cloudflare:workers'
import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { expect } from 'vitest'
import { app } from '../../src/index'
import type { Env } from '../../src/env'
import type { Graph } from '../../src/contracts'
import type { InboundEvent } from '../../src/integrations'
import { consumeInbound } from '../../src/jobs'
import { origin, seedAuth, fixtureCookie } from '../auth-helpers'
import type { Enviada } from './simuladores'

export type EloResultado = { nome: string; ok: boolean; ms: number; erro?: string }
declare module 'vitest' { interface TaskMeta { elos?: EloResultado[]; estresse?: Record<string, unknown> } }
type TaskLike = { meta: import('vitest').TaskMeta }

export async function elo<T>(task: TaskLike, nome: string, fn: () => Promise<T>): Promise<T> {
  const lista = (task.meta.elos ??= [])
  const t0 = performance.now()
  try {
    const r = await fn()
    lista.push({ nome, ok: true, ms: Math.round(performance.now() - t0) })
    return r
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e)
    lista.push({ nome, ok: false, ms: Math.round(performance.now() - t0), erro })
    throw new Error(`ELO "${nome}" FALHOU: ${erro}`)
  }
}

/** Chamada à API do painel como o dono do espaço `a` (a mesma que o painel usa). */
export async function api(metodo: string, caminho: string, corpo?: unknown, bindings: Env = env): Promise<Response> {
  return app.request(`${origin}/api/${caminho}`, { method: metodo, ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    headers: { 'x-workspace': 'a', origin, 'content-type': 'application/json', cookie: await fixtureCookie('a') } }, bindings)
}
export async function apiJson<T = any>(metodo: string, caminho: string, corpo?: unknown, esperado = 200, bindings: Env = env): Promise<T> {
  const r = await api(metodo, caminho, corpo, bindings)
  const texto = await r.text()
  if (r.status !== esperado) throw new Error(`${metodo} /api/${caminho} respondeu ${r.status} (esperado ${esperado}): ${texto.slice(0, 300)}`)
  return (texto ? JSON.parse(texto) : null) as T
}

export async function prepararEspaco() { await seedAuth() }

/** Fila de entrada fingida: guarda o que o webhook aceitou; `consumir` entrega ao consumidor real. */
export function filaCapturada() {
  const eventos: InboundEvent[] = []
  const bindings = { ...env, DEV_AUTO_LOGIN: '0', INBOUND: { send: async (e: InboundEvent) => { eventos.push(e) } } as unknown as Queue<InboundEvent> } as unknown as Env
  return { eventos, bindings }
}
export async function consumir(eventos: InboundEvent[]) {
  const batch = createMessageBatch('inbound', eventos.map(body => ({ id: `q-${crypto.randomUUID()}`, timestamp: new Date(), attempts: 1, body })))
  await consumeInbound(batch, env)
  return getQueueResult(batch, createExecutionContext())
}

let workflow: WorkflowIntrospector | undefined
export async function ligarWorkflows() {
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async m => { await m.disableSleeps() })
  return workflow
}
export async function desligarWorkflows() { await workflow?.dispose(); workflow = undefined }

export async function esperar<T>(descricao: string, ler: () => Promise<T>, pronto: (v: T) => boolean, ms = 30000): Promise<T> {
  const fim = Date.now() + ms
  let ultimo = await ler()
  while (!pronto(ultimo)) {
    if (Date.now() > fim) throw new Error(`Tempo esgotado esperando: ${descricao} (último valor: ${JSON.stringify(ultimo)})`)
    await new Promise(r => setTimeout(r, 25))
    ultimo = await ler()
  }
  return ultimo
}

export const sql = {
  um: async <T = number>(consulta: string, ...args: unknown[]) => env.DB.prepare(consulta).bind(...args).first<T>(),
  n: async (consulta: string, ...args: unknown[]) => (await env.DB.prepare(consulta).bind(...args).first<{ n: number }>())!.n,
  todas: async <T = any>(consulta: string, ...args: unknown[]) => (await env.DB.prepare(consulta).bind(...args).all<T>()).results,
}

const no = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, config })
/** Gatilho → mensagem com botão → (clique) condição por etiqueta → ação (etiqueta + campo) → mensagem final. */
export const grafoDaJornada = (): Graph => ({
  nodes: [no('start', 'trigger'),
    no('oferta', 'message', { blocks: [{ kind: 'text', text: 'Quer receber o material?' }, { kind: 'button', id: 'link', label: 'Quero o link', action: { type: 'go_to_node' } }] }),
    no('cond', 'condition', { match: 'all', rules: [{ type: 'tag', tag_id: 'tag-a', operator: 'has' }] }),
    no('acao', 'action', { actions: [{ type: 'add_tag', tag_id: 'tag-a' }, { type: 'set_custom_field_value', field_id: 'field-a', value: 'Curso' }] }),
    no('final', 'message', { blocks: [{ kind: 'text', text: 'Material enviado, valeu!' }] }),
    no('jatem', 'message', { blocks: [{ kind: 'text', text: 'Você já recebeu.' }] })] as Graph['nodes'],
  edges: [{ from: 'start', port: 'next', to: 'oferta' }, { from: 'oferta', port: 'link', to: 'cond' }, { from: 'cond', port: 'false', to: 'acao' },
    { from: 'cond', port: 'true', to: 'jatem' }, { from: 'acao', port: 'next', to: 'final' }],
})

/** Grafo do estresse: mensagem → espera → pergunta → mensagem final. */
export const grafoDoEstresse = (): Graph => ({
  nodes: [no('start', 'trigger'),
    no('oi', 'message', { blocks: [{ kind: 'text', text: 'Oi! Vou te fazer uma pergunta.' }] }),
    no('espera', 'smart_delay', { duration: { value: 1, unit: 'seconds' } }),
    no('pergunta', 'question', { text: 'Qual é o seu e-mail?', answer_type: 'text', field_id: 'field-a', retry_message: 'Tente de novo.', max_attempts: 2, skip: false, timeout: { value: 30, unit: 'minutes' }, choices: [] }),
    no('ok', 'message', { blocks: [{ kind: 'text', text: 'Anotado, obrigado.' }] }),
    no('sem', 'message', { blocks: [{ kind: 'text', text: 'Sem resposta.' }] })] as Graph['nodes'],
  edges: [{ from: 'start', port: 'next', to: 'oi' }, { from: 'oi', port: 'next', to: 'espera' }, { from: 'espera', port: 'next', to: 'pergunta' },
    { from: 'pergunta', port: 'success', to: 'ok' }, { from: 'pergunta', port: 'no_response', to: 'sem' }],
})

/**
 * Publica o grafo pela API do painel e cria a palavra-chave "quero" ligada a ele, como o usuário faria.
 * `connectionId` prende o gatilho à conexão criada pelo teste: sem ele a API escolhe entre as conexões do mesmo tipo (conectadas primeiro,
 * depois por id), e a fixture já traz `ch-a` (instagram) no espaço `a`, que ganha de qualquer uuid começado em d, e ou f (~19%).
 */
export async function publicarFluxo(channelKind: string, grafo: Graph, palavra = 'quero', connectionId?: string) {
  await env.DB.batch([env.DB.prepare("DELETE FROM keywords WHERE workspace_id='a'"), env.DB.prepare("DELETE FROM triggers WHERE workspace_id='a'")])
  await apiJson('PUT', 'automations/auto-a/draft', { graph: grafo })
  await apiJson('POST', 'automations/auto-a/publish', undefined, 201)
  await apiJson('POST', 'keywords', { name: 'Receber material', channel: channelKind, automation_id: 'auto-a', active: true, ...(connectionId ? { connection_id: connectionId } : {}), rules: [{ condition: 'contains', words: [palavra] }] }, 201)
}

/** Contrato de um canal para a jornada padrão. */
export interface Canal {
  id: string
  /** Tipo do canal na API de palavras-chave (whatsapp, telegram, instagram...). */
  tipo: string
  /** Cria a conexão pela API real e devolve o id (e o que mais o canal precisar). */
  conectar(): Promise<string>
  /** Sincroniza modelos, se o canal tiver. */
  sincronizarModelos?(channelId: string): Promise<void>
  usuario(n: number): string
  /** Entrega ao webhook real a mensagem de texto de um contato e devolve o status HTTP + os eventos que foram para a fila. */
  mensagem(usuario: string, texto: string, seq: number): Promise<{ status: number; eventos: InboundEvent[] }>
  clique(usuario: string, botaoId: string, titulo: string, seq: number): Promise<{ status: number; eventos: InboundEvent[] }>
  enviadas(): Enviada[]
  /** Transmissão com modelo (só canais com modelos). */
  transmissaoComModelo?(channelId: string): Promise<void>
}

export async function esperarEnviadas(canal: Canal, quantas: number, descricao: string) {
  try { return await esperar(descricao, async () => canal.enviadas(), e => e.length >= quantas) } catch (e) {
    // Sem isto o timeout só diz "[]": mostra onde a execução parou (estado da run e de cada parte enviada).
    const runs = await sql.todas("SELECT id,status,current_node_id,error FROM flow_runs ORDER BY created_at DESC LIMIT 3")
    const envios = await sql.todas('SELECT run_id,step_index,part,status FROM flow_outbound ORDER BY rowid DESC LIMIT 6')
    const entrada = await sql.todas('SELECT processed_at IS NOT NULL AS processado, planned_at IS NOT NULL AS planejado FROM inbound_events ORDER BY received_at DESC LIMIT 3')
    const contatos = await sql.todas('SELECT cc.opted_in, c.status, ch.status AS canal, ch.connection_state FROM contact_channels cc JOIN contacts c ON c.id=cc.contact_id JOIN channels ch ON ch.id=cc.channel_id ORDER BY cc.rowid DESC LIMIT 2')
    throw new Error(`${e instanceof Error ? e.message : e} | runs=${JSON.stringify(runs)} envios=${JSON.stringify(envios)} entrada=${JSON.stringify(entrada)} contatos=${JSON.stringify(contatos)}`)
  }
}

/** A jornada do usuário novo. Cada elo é nomeado; falhou, aponta qual. */
export async function jornadaPadrao(task: TaskLike, canal: Canal) {
  const channelId = await elo(task, 'conectar', () => canal.conectar())
  if (canal.sincronizarModelos) await elo(task, 'sincronizar modelos', () => canal.sincronizarModelos!(channelId))
  await elo(task, 'criar e publicar fluxo com palavra-chave', () => publicarFluxo(canal.tipo, grafoDaJornada(), 'quero', channelId))
  const u = canal.usuario(1)
  let seq = 0
  await elo(task, 'contato manda a palavra → recebe a mensagem', async () => {
    const r = await canal.mensagem(u, 'quero', ++seq)
    expect(r.status, 'o webhook deveria aceitar a mensagem').toBe(200)
    expect(r.eventos.length, 'o webhook deveria colocar o evento na fila').toBeGreaterThan(0)
    await consumir(r.eventos)
    const e = await esperarEnviadas(canal, 1, 'primeira mensagem do fluxo')
    expect(e[0].texto).toBe('Quer receber o material?')
    expect(e[0].botoes.map(b => b.titulo)).toEqual(['Quero o link'])
  })
  await elo(task, 'contato responde o botão → condição → ação → mensagem final', async () => {
    const botao = canal.enviadas()[0].botoes[0]
    const r = await canal.clique(u, botao.id, botao.titulo, ++seq)
    expect(r.status).toBe(200)
    await consumir(r.eventos)
    const e = await esperarEnviadas(canal, 2, 'mensagem final')
    expect(e[1].texto).toBe('Material enviado, valeu!')
    const run = await esperar('execução concluída', () => sql.um<{ status: string }>("SELECT status FROM flow_runs WHERE workspace_id='a' ORDER BY created_at DESC LIMIT 1"), v => v?.status === 'done')
    expect(run?.status).toBe('done')
  })
  await elo(task, 'ação gravou etiqueta e campo no contato', async () => {
    const contato = await sql.um<{ contact_id: string }>("SELECT contact_id FROM flow_runs WHERE workspace_id='a' ORDER BY created_at DESC LIMIT 1")
    expect(await sql.n("SELECT count(*) n FROM contact_tags WHERE contact_id=? AND tag_id='tag-a'", contato!.contact_id)).toBe(1)
    const valor = await sql.um<{ value: string }>("SELECT value FROM contact_field_values WHERE contact_id=? AND field_id='field-a'", contato!.contact_id)
    expect(JSON.parse(valor!.value)).toBe('Curso')
  })
  await elo(task, 'webhook repetido e fora de ordem não duplica nada', async () => {
    const antes = canal.enviadas().length, runs = await sql.n('SELECT count(*) n FROM flow_runs')
    const repetido = await canal.mensagem(u, 'quero', 1)   // mesmo id da primeira entrega
    expect(repetido.status).toBe(200)
    await consumir(repetido.eventos)
    await new Promise(r => setTimeout(r, 150))
    expect(canal.enviadas().length, 'mensagens enviadas depois de webhook repetido').toBe(antes)
    expect(await sql.n('SELECT count(*) n FROM flow_runs'), 'execuções depois de webhook repetido').toBe(runs)
  })
  if (canal.transmissaoComModelo) await elo(task, 'transmissão com modelo', () => canal.transmissaoComModelo!(channelId))
}
