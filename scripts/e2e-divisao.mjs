// Divisão das jornadas entre ambientes paralelos pelo tempo medido (scripts/e2e-paralelo.mjs).
// Grupo = um arquivo de spec num projeto ("desktop › auth.spec.ts"): é a menor unidade que o Playwright roda em ordem
// num worker só (fullyParallel: false). O --shard divide por quantidade de testes; aqui divide pela duração da última rodada.

const PADRAO_S = 15 // grupo sem medida: 15 s por teste

/** Percorre o JSON do reporter `json` (de `--list` ou de uma rodada) chamando `visitar(projeto, arquivo, teste)`. */
export function percorrer(relatorio, visitar) {
  const andar = (suite, arquivo) => {
    const arq = suite.file ?? arquivo
    for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) visitar(t.projectName, arq, t)
    for (const s of suite.suites ?? []) andar(s, arq)
  }
  for (const s of relatorio.suites ?? []) andar(s, s.file)
}

export const chaveGrupo = (projeto, arquivo) => `${projeto} › ${arquivo}`

/** Quantos testes cada grupo tem (JSON de `playwright test --list --reporter=json`). */
export function contarGrupos(lista) {
  const n = new Map()
  percorrer(lista, (p, a) => n.set(chaveGrupo(p, a), (n.get(chaveGrupo(p, a)) ?? 0) + 1))
  return n
}

/** Duração em segundos de cada grupo numa rodada (JSON do reporter `json` do merge-reports). */
export function duracoesDoRelatorio(relatorio) {
  const d = {}
  percorrer(relatorio, (p, a, t) => {
    const ms = (t.results ?? []).reduce((s, r) => s + (r.duration ?? 0), 0)
    d[chaveGrupo(p, a)] = (d[chaveGrupo(p, a)] ?? 0) + ms / 1000
  })
  return d
}

/** Reparte os grupos em `n` listas de tempo parecido (maior primeiro, sempre na lista mais leve). */
export function dividir(grupos, duracoes, n) {
  const peso = ([chave, qtd]) => duracoes[chave] ?? qtd * PADRAO_S
  const ordem = [...grupos].sort((a, b) => peso(b) - peso(a) || a[0].localeCompare(b[0]))
  const caixas = Array.from({ length: n }, () => ({ grupos: [], segundos: 0 }))
  for (const g of ordem) {
    const leve = caixas.reduce((m, c) => (c.segundos < m.segundos ? c : m))
    leve.grupos.push(g[0]); leve.segundos += peso(g)
  }
  return caixas
}

/** Conteúdo do arquivo de `--test-list`: `[projeto] › arquivo` casa todos os testes do arquivo naquele projeto. */
export const listaDeTestes = grupos => grupos.map(g => { const [p, a] = g.split(" › "); return `[${p}] › ${a}` }).join("\n") + "\n"
