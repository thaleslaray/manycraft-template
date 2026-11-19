// Funções puras do `npm run check`: achar o que falhou em cada suíte (para repetir só isso uma vez),
// apontar os testes instáveis, montar o resumo final e avisar quando outra pasta ocupa a máquina com testes.
import { relative } from "node:path"

// Relatório JSON do vitest (--reporter=json): arquivos que falharam (relativos a `base`) e os testes que falharam neles.
// Arquivo que falhou sem teste nenhum falho (erro ao carregar, hook) entra com teste "(arquivo)".
export function falhasVitest(json, base) {
  const arquivos = [], testes = []
  for (const r of json?.testResults ?? []) {
    if (r.status !== "failed") continue
    const arquivo = base ? relative(base, r.name) : r.name
    arquivos.push(arquivo)
    const falhos = (r.assertionResults ?? []).filter(a => a.status === "failed")
    if (!falhos.length) testes.push({ arquivo, teste: "(arquivo)" })
    for (const a of falhos) testes.push({ arquivo, teste: a.fullName || a.title })
  }
  return { arquivos, testes }
}

// Saída do reporter spec do node --test: o bloco "✖ failing tests:" lista "test at <arquivo>:<l>:<c>" seguido de "✖ <nome> (ms)".
export function falhasNodeTest(texto) {
  const semCor = texto.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
  const i = semCor.lastIndexOf("✖ failing tests:")
  if (i < 0) return { arquivos: [], testes: [] }
  const linhas = semCor.slice(i).split("\n")
  const testes = []
  for (let k = 0; k < linhas.length; k++) {
    const m = linhas[k].match(/^test at (.+?):\d+:\d+\s*$/)
    if (!m) continue
    const nome = (linhas[k + 1] ?? "").match(/^✖ (.*?)(?: \([\d.]+m?s\))?\s*$/)
    testes.push({ arquivo: m[1].replace(/^file:\/\//, ""), teste: nome ? nome[1] : "(sem nome)" })
  }
  return { arquivos: [...new Set(testes.map(t => t.arquivo))], testes }
}

// Relatório JSON do Playwright: testes com resultado inesperado (status "unexpected"), com o projeto entre colchetes.
export function falhasPlaywright(json) {
  const testes = []
  const andar = (suite, arquivo, titulos) => {
    const arq = suite.file ?? arquivo
    const nomes = suite.title && suite.title !== arq ? [...titulos, suite.title] : titulos
    for (const sp of suite.specs ?? []) {
      for (const t of sp.tests ?? []) {
        if (t.status === "unexpected") testes.push({ arquivo: sp.file ?? arq, teste: `${[...nomes, sp.title].join(" > ")} [${t.projectName}]` })
      }
    }
    for (const s of suite.suites ?? []) andar(s, arq, nomes)
  }
  for (const s of json?.suites ?? []) andar(s, s.file, [])
  return testes
}

export const linhaInstavel = t => `instável: ${t.arquivo} > ${t.teste}`

// Resumo do fim do check: uma linha por etapa, os instáveis (falharam e passaram na repetição) e as etapas que falharam.
export function montarResumo({ linhas, instaveis = [], falharam = [] }) {
  const partes = [linhas.join("\n")]
  if (instaveis.length) partes.push(instaveis.map(linhaInstavel).join("\n"))
  if (falharam.length) partes.push(`FALHOU: ${falharam.join(", ")}`)
  return partes.join("\n\n")
}

// `ps -axo pid=,command=`: processos de teste (playwright, vitest, workerd, vite) de outras pastas, agrupados pela pasta do projeto.
// A pasta é o que vem antes de /node_modules/ no caminho do executável; dentro de ~/Projetos/<x>/ conta como <x> inteiro
// (as worktrees de um projeto somam no projeto). Processo sem caminho absoluto (npm exec, vite relativo) não entra.
const FERRAMENTA = /\/node_modules\/(?:\.bin\/)?(?:playwright|vitest|vite)(?:\/|$)|\/node_modules\/@playwright\/|\/workerd(?:$|\s)|\/bin\/workerd\b|\/playwright\/lib\/worker\//
export function processosAlheios(psTexto, raiz, pidProprio) {
  const contagem = new Map()
  for (const linha of psTexto.split("\n")) {
    const m = linha.trim().match(/^(\d+)\s+(.*)$/)
    if (!m || Number(m[1]) === pidProprio) continue
    // Só os primeiros termos (executável, opções do node, script): um `zsh -c "... vitest ..."` não chega a contar.
    if (/^\S*\/(?:z|ba)?sh\s/.test(m[2])) continue
    const termos = m[2].split(/\s+/).slice(0, 4).filter(t => t.startsWith("/"))
    const exe = termos.find(t => FERRAMENTA.test(t))
    if (!exe) continue
    const corte = exe.indexOf("/node_modules/")
    if (corte < 0) continue
    let pasta = exe.slice(0, corte)
    if (pasta === raiz || pasta.startsWith(raiz + "/")) continue
    const proj = pasta.match(/^(.*?\/Projetos\/[^/]+)/)
    if (proj) pasta = proj[1]
    contagem.set(pasta, (contagem.get(pasta) ?? 0) + 1)
  }
  return [...contagem].map(([pasta, n]) => ({ pasta, n })).sort((a, b) => b.n - a.n)
}

export function avisoMaquina(lista, home) {
  if (!lista.length) return null
  const curto = p => (home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p)
  const total = lista.reduce((s, x) => s + x.n, 0)
  return `máquina ocupada: ${total} processos de teste de ${lista.map(x => `${curto(x.pasta)} (${x.n})`).join(", ")}; tempos e estouros podem vir disso`
}
