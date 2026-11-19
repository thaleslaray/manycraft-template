// D1 com atraso fixo por ida, só para medir: sem ele o banco local responde em menos de 1 ms, o relógio do workerd não
// avança e o "em fila" do rastreio vira ruído. Com 15 ms por ida, consultas disparadas juntas se sobrepõem e as em fila não.
const ATRASO_MS = 15
const esperar = () => new Promise<void>(resolve => setTimeout(resolve, ATRASO_MS))
type Declaracao = D1PreparedStatement & { __real?: D1PreparedStatement }
function declaracao(real: D1PreparedStatement): D1PreparedStatement {
  const atrasar = <T>(fn: () => Promise<T>) => async () => { await esperar(); return fn() }
  return {
    __real: real,
    bind: (...valores: unknown[]) => declaracao(real.bind(...valores)),
    first: (...args: unknown[]) => atrasar(() => (real.first as (...a: unknown[]) => Promise<unknown>)(...args))(),
    run: atrasar(() => real.run()),
    all: atrasar(() => real.all()),
    raw: (...args: unknown[]) => atrasar(() => (real.raw as (...a: unknown[]) => Promise<unknown>)(...args))(),
  } as unknown as D1PreparedStatement
}
export function d1ComAtraso(db: D1Database): D1Database {
  return {
    prepare: (sql: string) => declaracao(db.prepare(sql)),
    batch: (async (itens: Declaracao[]) => { await esperar(); return db.batch(itens.map(item => item.__real ?? item)) }) as D1Database['batch'],
    exec: async (sql: string) => { await esperar(); return db.exec(sql) },
    dump: () => db.dump(),
    withSession: (...args: Parameters<D1Database['withSession']>) => db.withSession(...args),
  } as unknown as D1Database
}
