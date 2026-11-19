// D1 que roda `gancho` uma vez, logo antes de executar a primeira consulta cujo SQL contém `trecho` (sozinha ou dentro de um lote).
// Encaixa um escritor concorrente, ou uma queda do banco (o gancho lança), no ponto exato de uma gravação. O resto passa direto.
export function d1ComGancho(db: D1Database, trecho: string, gancho: () => unknown): D1Database {
  let pendente = true
  const disparar = async () => { if (!pendente) return; pendente = false; await gancho() }
  // Declaração marcada -> real: o lote do D1 recebe sempre a declaração verdadeira.
  const reais = new WeakMap<object, D1PreparedStatement>()
  const marcar = (real: D1PreparedStatement): D1PreparedStatement => {
    const marcada = new Proxy(real, { get(alvo, chave) {
      if (chave === 'bind') return (...valores: unknown[]) => marcar(alvo.bind(...valores))
      const valor = Reflect.get(alvo, chave)
      if (typeof valor !== 'function') return valor
      if (chave === 'run' || chave === 'first' || chave === 'all' || chave === 'raw') return async (...args: unknown[]) => { await disparar(); return valor.apply(alvo, args) }
      return valor.bind(alvo)
    } })
    reais.set(marcada, real)
    return marcada
  }
  return new Proxy(db, { get(alvo, chave) {
    if (chave === 'prepare') return (sql: string) => sql.includes(trecho) ? marcar(alvo.prepare(sql)) : alvo.prepare(sql)
    if (chave === 'batch') return async (declaracoes: D1PreparedStatement[]) => {
      if (declaracoes.some(d => reais.has(d))) await disparar()
      return alvo.batch(declaracoes.map(d => reais.get(d) ?? d))
    }
    const valor = Reflect.get(alvo, chave)
    return typeof valor === 'function' && chave !== 'constructor' ? valor.bind(alvo) : valor
  } })
}
