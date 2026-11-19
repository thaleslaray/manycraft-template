import { AsyncLocalStorage } from 'node:async_hooks'
import { logTaskError } from '../log-error'

/** Tempos finos do caminho rápido (log 'inline_timing'): duração de cada fase e de cada passo, e quantas idas ao D1 cada um fez.
 * Custo em produção: um Proxy no D1 que soma um contador e um Date.now() por fase. Sem payload nem ids no log. */
type Entry = { name: string; ms: number; q: number; rt: number }
export type Timing = { started: number; last: number; q: number; qLast: number; entries: Entry[]
  /** Idas em fila: uma consulta que começa sem nenhuma outra em voo abre uma nova ida (as paralelas contam uma vez). */
  rt: number; rtLast: number; inFlight: number
  /** Leituras repetidas dentro da mesma execução em linha (conexão, run ativo...). */
  memo: Map<string, { at: number; value: Promise<unknown> }>
  /** Trabalho que não decide a resposta (publicar no inbox, atribuição, etiquetas): roda depois do envio. */
  deferred: (() => Promise<unknown>)[]; flushing?: Promise<void>
  /** Passo repetível em linha: as gravações dele entram no lote do próximo passo com efeito (inlineStep). */
  queueWrite?: (statement: D1PreparedStatement) => void }

const store = new AsyncLocalStorage<Timing>()

export function newTiming(now = Date.now()): Timing { return { started: now, last: now, q: 0, qLast: 0, rt: 0, rtLast: 0, inFlight: 0, entries: [], memo: new Map(), deferred: [] } }

/** Memória de leitura só da execução em linha (fora dela, sempre lê). Chaves 'v:' são voláteis: valem até `forgetVolatile` ou VOLATILE_MS. */
const VOLATILE_MS = 2_000
export function inlineMemo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const t = store.getStore()
  if (!t) return fn()
  const hit = t.memo.get(key)
  if (hit && (!key.startsWith('v:') || Date.now() - hit.at < VOLATILE_MS)) return hit.value as Promise<T>
  const value = fn()
  t.memo.set(key, { at: Date.now(), value })
  value.catch(() => { if (t.memo.get(key)?.value === value) t.memo.delete(key) })
  return value
}
/** Leitura já feita nesta execução em linha (sem disparar outra). */
export function peekInline<T>(key: string): Promise<T> | undefined {
  return store.getStore()?.memo.get(key)?.value as Promise<T> | undefined
}
/** Gravação de um passo repetível: em linha, vai no lote do próximo passo com efeito (ou da passagem ao Workflow); fora dela, na hora. */
export async function writeSoon(statement: D1PreparedStatement): Promise<void> {
  const queue = store.getStore()?.queueWrite
  if (queue) queue(statement)
  else await statement.run()
}
/** Enquanto `fn` roda, writeSoon entrega as gravações a `queue`. */
export async function queueingWrites<T>(queue: (statement: D1PreparedStatement) => void, fn: () => Promise<T>): Promise<T> {
  const t = store.getStore()
  if (!t) return fn()
  const previous = t.queueWrite
  t.queueWrite = queue
  try { return await fn() } finally { t.queueWrite = previous }
}
/** Antes de um passo com efeito (envio, métrica, ação), o estado vivo é relido. */
export function forgetVolatile(prefix = 'v:'): void {
  const t = store.getStore()
  if (t) for (const key of [...t.memo.keys()]) if (key.startsWith(prefix)) t.memo.delete(key)
}
/** Fora da execução em linha, roda já (como antes). */
export async function deferInline(fn: () => Promise<unknown>): Promise<void> {
  const t = store.getStore()
  if (t) t.deferred.push(fn)
  else await fn()
}
/** Roda o adiado, na ordem. Um erro não derruba o resto (cada tarefa já engolia os próprios erros, ou é republicação). */
export function flushDeferred(): Promise<void> {
  const t = store.getStore()
  if (!t) return Promise.resolve()
  // Um executor só: duas chamadas (depois do primeiro envio e no fim) nunca embaralham a ordem.
  t.flushing ??= (async () => {
    try {
      while (t.deferred.length) {
        const task = t.deferred.shift()!
        try { await task() } catch (error) { logTaskError('inline_deferred_failed', error) }
      }
    } finally { t.flushing = undefined }
  })()
  return t.flushing
}
export const currentTiming = () => store.getStore()
export function runWithTiming<T>(timing: Timing, fn: () => Promise<T>): Promise<T> { return store.run(timing, fn) }

/** Fecha a fase em curso (desde a marca anterior) com o nome dado. */
export function mark(name: string): void {
  const t = store.getStore()
  if (!t) return
  const now = Date.now()
  t.entries.push({ name, ms: now - t.last, q: t.q - t.qLast, rt: t.rt - t.rtLast })
  t.last = now; t.qLast = t.q; t.rtLast = t.rt
}

/** Mede um trecho isolado (passos do executor) sem mexer na marca das fases. */
export async function measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = store.getStore()
  if (!t) return fn()
  // O que rodou entre a marca anterior e este trecho (código fora dos passos) fica visível como "pre.<nome>".
  if (Date.now() > t.last || t.q > t.qLast) mark(`pre.${name}`)
  const start = Date.now(), q = t.q, rt = t.rt
  try { return await fn() } finally {
    const now = Date.now()
    t.entries.push({ name, ms: now - start, q: t.q - q, rt: t.rt - rt })
    // A próxima fase começa depois do trecho medido.
    t.last = now; t.qLast = t.q; t.rtLast = t.rt
  }
}

export function logTiming(event: string, extra: Record<string, unknown> = {}): void {
  const t = store.getStore()
  if (!t) return
  // Fases sem consulta e sem tempo ficam de fora (log curto).
  console.log(JSON.stringify({ event, ...extra, totalMs: Date.now() - t.started, totalQ: t.q, totalRt: t.rt,
    phases: t.entries.filter(e => e.ms || e.q).map(e => `${e.name}=${e.ms}ms/${e.q}q/${e.rt}rt`) }))
}

const counted = new WeakMap<D1Database, D1Database>()
/** Conta uma ida e acompanha quantas estão em voo (idas em fila = as que começam sem nenhuma outra em voo). */
function track<T>(run: () => Promise<T>, sql?: string): Promise<T> {
  const t = store.getStore()
  if (!t) return run()
  t.q++
  if (t.inFlight === 0) t.rt++
  t.inFlight++
  if (sql !== undefined && (globalThis as { __SQL?: boolean }).__SQL) console.log('SQL', t.rt, sql.replace(/\s+/g, ' ').slice(0, 110))
  const done = () => { t.inFlight-- }
  const promise = run()
  promise.then(done, done)
  return promise
}
const COUNTED_METHODS = new Set(['first', 'run', 'all', 'raw'])

function countStatement(statement: D1PreparedStatement, sql = ''): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, prop) {
      if (prop === '__real') return target
      const value = Reflect.get(target, prop)
      if (typeof value !== 'function') return value
      if (prop === 'bind') return (...args: unknown[]) => countStatement((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args), sql)
      if (COUNTED_METHODS.has(prop as string)) return (...args: unknown[]) => track(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args), sql)
      return value.bind(target)
    },
  })
}
const realOf = (statement: D1PreparedStatement) => (statement as D1PreparedStatement & { __real?: D1PreparedStatement }).__real ?? statement

/** D1 que conta cada ida (prepare+first/run/all/raw, batch, exec) na medição em curso. Fora de uma medição, só repassa. */
export function countedDb(db: D1Database): D1Database {
  const cached = counted.get(db)
  if (cached) return cached
  const proxy = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      if (prop === 'prepare') return (sql: string) => countStatement(target.prepare(sql), sql)
      if (prop === 'batch') return (statements: D1PreparedStatement[]) => track(() => target.batch(statements.map(realOf)), `batch(${statements.length})`)
      if (prop === 'exec') return (sql: string) => track(() => target.exec(sql), sql)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  counted.set(db, proxy)
  return proxy
}

/** No fim do processamento: espera todo o adiado (inclusive o que chegou durante a última rodada). */
export async function drainDeferred(): Promise<void> {
  const t = store.getStore()
  if (!t) return
  do { await flushDeferred() } while (t.deferred.length)
}
