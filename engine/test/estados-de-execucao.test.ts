import { expect, it } from 'vitest'
import { activeRunStatuses, activeRunStatusSql, finalRunStatuses, runStatuses, runTransitions } from '../src/flow/run-state'
import init from '../migrations/0001_init.sql?raw'

const fontes = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const fonteUnica = (arquivo: string) => arquivo.endsWith('/flow/run-state.ts')
const lista = (estados: readonly string[]) => {
  const um = `'(?:${estados.join('|')})'`
  return new RegExp(`[([]\\s*${um}(?:\\s*,\\s*${um}){${estados.length - 1}}\\s*[)\\]]`)
}
const copias = (padrao: RegExp) => Object.entries(fontes).filter(([arquivo, texto]) => !fonteUnica(arquivo) && padrao.test(texto)).map(([arquivo]) => arquivo)

it('os estados ativos são os de flow_runs menos os finais (done, failed, cancelled)', () => {
  const check = /CREATE TABLE flow_runs[\s\S]*?check \(status in \(([^)]*)\)\)/.exec(init as string)
  const todos = check![1].split(',').map(s => s.trim().replace(/'/g, ''))
  expect([...activeRunStatuses, ...finalRunStatuses].sort()).toEqual(todos.sort())
  expect([...runStatuses].sort()).toEqual(todos.sort())
  expect(activeRunStatusSql).toBe("'running','waiting_delay','waiting_click','waiting_input'")
})

it('nenhum arquivo do motor copia a lista de estados ativos de flow_runs: todos usam a constante', () => {
  expect(copias(lista(activeRunStatuses))).toEqual([])
})

// A cópia que resta é de um arquivo de outra frente (sequências); a lista não cresce.
it('ninguém copia a lista de estados finais nem a de estados que aceitam clique', () => {
  expect(copias(lista(finalRunStatuses))).toEqual(['../src/flow/sequences.ts'])
  expect(copias(/\[\s*'running'\s*,\s*'waiting_click'\s*\]/)).toEqual([])
})

it('final é final: nenhuma transição sai de done, failed ou cancelled', () => {
  for (const [to, from] of Object.entries(runTransitions)) for (const origin of finalRunStatuses) expect(from, `${origin} → ${to}`).not.toContain(origin)
})
