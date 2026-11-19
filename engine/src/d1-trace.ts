// Rastreio das idas ao D1, SÓ para desenvolvimento: conta quantas consultas um pedido faz e quantas
// ficam em fila (cada ida em fila custa uma viagem de rede até o banco; em produção o D1 está a
// um continente do Worker). Quem liga é o middleware de `src/index.ts`, atrás de
// `APP_ENV === 'development'` e do header de pedido `x-d1-trace: 1`: em produção é uma comparação
// de string e nada mais (custo zero, nenhuma consulta é envolvida).
export const D1_TRACE_HEADER = 'x-d1-trace'
/** Resposta de desenvolvimento: "<idas>,<em fila>" (os testes e o curl leem daqui). */
export const D1_TRACE_RESULT_HEADER = 'x-d1-trace-resumo'

type Ida = { sql: string; start: number; end: number }

/** Quantas idas e qual a fila mais longa (idas que só começam depois de a anterior acabar). */
export function resumirIdas(idas: Pick<Ida, 'start' | 'end'>[]) {
  const ordenadas = [...idas].sort((a, b) => a.start - b.start)
  const fundura: number[] = []
  for (const [i, ida] of ordenadas.entries()) {
    let melhor = 0
    for (let j = 0; j < i; j++) if (ordenadas[j]!.end <= ida.start) melhor = Math.max(melhor, fundura[j]!)
    fundura[i] = melhor + 1
  }
  return { idas: idas.length, emFila: Math.max(0, ...fundura) }
}

function resumirSql(sql: string) {
  const limpo = sql.replace(/\s+/g, ' ').trim()
  const tabela = /\bfrom\s+"?(\w+)"?/i.exec(limpo)?.[1] ?? /\binto\s+"?(\w+)"?/i.exec(limpo)?.[1] ?? /^update\s+"?(\w+)"?/i.exec(limpo)?.[1] ?? '?'
  return `${limpo.split(' ', 1)[0]?.toLowerCase() ?? '?'} ${tabela}`
}

type Rastreada = D1PreparedStatement & { __real: D1PreparedStatement }

/**
 * Envolve um D1 (ou sessão D1): cada `all/run/raw/first`, `exec` e `batch` vira uma ida
 * registrada (e uma linha `[d1]` no terminal). `fim()` imprime o resumo e o devolve.
 */
export function rastrearD1(db: D1Database, rotulo: string, escrever: (linha: string) => void = console.log) {
  const inicio = performance.now()
  const idas: Ida[] = []
  async function medir<T>(sql: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now() - inicio
    try { return await fn() } finally {
      const end = performance.now() - inicio
      idas.push({ sql, start, end })
      escrever(`[d1] ${rotulo} +${start.toFixed(0)}ms (${(end - start).toFixed(0)}ms) ${sql}`)
    }
  }
  function envolver(real: D1PreparedStatement, sql: string): Rastreada {
    const resumo = resumirSql(sql)
    return {
      __real: real,
      bind: (...valores: unknown[]) => envolver(real.bind(...valores), sql),
      first: (...args: unknown[]) => medir(resumo, () => (real.first as (...a: unknown[]) => Promise<unknown>)(...args)),
      run: () => medir(resumo, () => real.run()),
      all: () => medir(resumo, () => real.all()),
      raw: (...args: unknown[]) => medir(resumo, () => (real.raw as (...a: unknown[]) => Promise<unknown>)(...args)),
    } as unknown as Rastreada
  }
  const rastreado = {
    prepare: (sql: string) => envolver(db.prepare(sql), sql),
    batch: ((declaracoes: Rastreada[]) => medir(`batch(${declaracoes.length})`, () => db.batch(declaracoes.map(d => d.__real ?? d)))) as D1Database['batch'],
    exec: (sql: string) => medir(resumirSql(sql), () => db.exec(sql)),
    dump: () => db.dump(),
    withSession: (...args: Parameters<D1Database['withSession']>) => db.withSession(...args),
  } as unknown as D1Database
  return {
    db: rastreado,
    resumo: () => resumirIdas(idas),
    fim() {
      const resumo = resumirIdas(idas)
      escrever(`[d1] ${rotulo} RESUMO: ${resumo.idas} ida(s) ao D1, ${resumo.emFila} em fila`)
      return resumo
    },
  }
}
