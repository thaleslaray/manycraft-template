import { expect, it } from 'vitest'
import { conferirCatalogo } from '../src/api-docs/conferir'
import type { AreaCatalogo } from '../src/api-docs/tipos'

const e = (rota: string) => { const [metodo, caminho] = rota.split(' '); return { metodo: metodo as 'GET', caminho: caminho!, resumo: 'R.' } }
const a = (area: string, entradas: ReturnType<typeof e>[]): AreaCatalogo => ({ area, nome: area, descricao: 'D.', entradas })
const v1 = a('public-v1', [e('GET /api/public/v1/page/getInfo')])
const base = { rotasV1: ['GET /api/public/v1/page/getInfo'], v1 }

it('catálogo completo passa', () => {
  const areas = [a('contacts', [e('GET /api/contacts'), e('DELETE /api/contacts/:id')])]
  expect(conferirCatalogo({ ...base, liberadas: ['GET /api/contacts', 'DELETE /api/contacts/:id'], areas })).toEqual([])
})

it('toda rota liberada precisa de entrada (não há lista de pendências); entrada órfã falha', () => {
  const areas = [a('contacts', [e('GET /api/contacts/sumiu')])]
  expect(conferirCatalogo({ ...base, liberadas: ['GET /api/contacts', 'DELETE /api/contacts/:id'], areas })).toEqual([
    'rota liberada sem catálogo: GET /api/contacts (área contacts)',
    'rota liberada sem catálogo: DELETE /api/contacts/:id (área contacts)',
    'entrada órfã (rota não liberada): GET /api/contacts/sumiu',
  ])
})

it('entrada repetida e entrada na área errada falham', () => {
  const areas = [a('contacts', [e('GET /api/contacts'), e('GET /api/contacts'), e('GET /api/tags')]), a('tags', [])]
  expect(conferirCatalogo({ ...base, liberadas: ['GET /api/contacts', 'GET /api/tags'], areas })).toEqual([
    'entrada repetida: GET /api/contacts',
    'entrada na área errada: GET /api/tags está em contacts (área tags)',
  ])
})

it('área sem nome legível ou sem descrição falha', () => {
  const areas: AreaCatalogo[] = [{ area: 'contacts', nome: '', descricao: ' ', entradas: [e('GET /api/contacts')] }]
  expect(conferirCatalogo({ ...base, liberadas: ['GET /api/contacts'], areas })).toEqual([
    'área sem nome legível: contacts',
    'área sem descrição: contacts',
  ])
})

it('a seção v1 tem de cobrir as rotas montadas em /api/public/v1, sem sobra', () => {
  expect(conferirCatalogo({ liberadas: [], areas: [], rotasV1: ['POST /api/public/v1/page/createTag'], v1 })).toEqual([
    'rota v1 sem catálogo: POST /api/public/v1/page/createTag',
    'entrada v1 órfã: GET /api/public/v1/page/getInfo',
  ])
})
