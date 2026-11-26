import type { AreaCatalogo } from '../tipos'
import { segmentInputSchema } from '../../segments'
import { z } from 'zod'

const segmentoResposta = z.object({
  id: z.string(),
  name: z.string(),
  filter: z.object({}).describe('Filtro avançado de contatos, no mesmo formato do `filter` de `POST /api/contacts/query`.'),
  filterKind: z.enum(['general', 'email']).describe('`email`: filtro do canal de e-mail (aberturas, cliques...); `general`: os demais.'),
  total: z.number().int().nullable().describe('Contatos (não excluídos) que atendem ao filtro agora; `null` quando o filtro não pôde ser calculado (veja `error`).'),
  error: z.string().optional().describe('Por que o total não saiu (ex.: o filtro usa uma tag ou campo que foi apagado).'),
})

// Área segments: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'segments',
  nome: 'Segmentos',
  descricao: 'Públicos salvos a partir de filtros de contatos.',
  entradas: [
    { metodo: 'GET', caminho: '/api/segments', resumo: 'Lista os segmentos salvos do espaço (até 200, em ordem de nome), com quantos contatos cada um alcança agora.', resposta: z.array(segmentoResposta) },
    { metodo: 'POST', caminho: '/api/segments', resumo: 'Salva um segmento: um nome e um filtro avançado de contatos.', corpo: segmentInputSchema, exemplo: { name: 'Clientes ativos', filter: { match: 'all', rules: [{ type: 'tag', tag_id: 'tag-cliente', operator: 'has' }] } }, resposta: segmentoResposta },
    { metodo: 'GET', caminho: '/api/segments/options', resumo: 'Opções para montar filtros: campos, tags, conexões e gatilhos do espaço.' },
    { metodo: 'GET', caminho: '/api/segments/:id', resumo: 'Mostra um segmento com o filtro e quantos contatos ele alcança agora.', resposta: segmentoResposta },
    { metodo: 'PUT', caminho: '/api/segments/:id', resumo: 'Substitui o nome e o filtro de um segmento.', corpo: segmentInputSchema, exemplo: { name: 'Clientes ativos', filter: { match: 'any', rules: [{ type: 'channel', channel: 'whatsapp', operator: 'subscribed' }] } } },
    { metodo: 'DELETE', caminho: '/api/segments/:id', resumo: 'Exclui um segmento (os contatos não são tocados).' },
  ],
}
