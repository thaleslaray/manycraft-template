import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { rastrearD1, resumirIdas } from '../src/d1-trace'

it('resumirIdas separa o que roda junto do que espera a anterior', () => {
  expect(resumirIdas([])).toEqual({ idas: 0, emFila: 0 })
  expect(resumirIdas([{ start: 0, end: 10 }, { start: 11, end: 20 }, { start: 21, end: 30 }])).toEqual({ idas: 3, emFila: 3 })
  expect(resumirIdas([{ start: 0, end: 10 }, { start: 1, end: 12 }, { start: 13, end: 20 }])).toEqual({ idas: 3, emFila: 2 })
})

it('rastrearD1 conta cada ida (first, all, run, batch, exec) e não muda o resultado', async () => {
  const linhas: string[] = []
  const rastro = rastrearD1(env.DB, 'teste', linha => linhas.push(linha))
  const row = await rastro.db.prepare('SELECT ? AS n').bind(7).first<{ n: number }>()
  expect(row?.n).toBe(7)
  await rastro.db.prepare('SELECT 1 AS a FROM "user" LIMIT 1').all()
  const lote = await rastro.db.batch([rastro.db.prepare('SELECT 1 AS x'), rastro.db.prepare('SELECT ? AS y').bind(2)])
  expect(lote).toHaveLength(2)
  expect(rastro.fim()).toEqual({ idas: 3, emFila: 3 })
  expect(linhas.at(-1)).toContain('RESUMO: 3 ida(s) ao D1, 3 em fila')
  expect(linhas.some(l => l.includes('batch(2)'))).toBe(true)
  expect(linhas.some(l => l.includes('select user'))).toBe(true)
})
