import type { AreaCatalogo } from '../tipos'
import { segmentInputSchema } from '../../segments'

// Área segments: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'segments',
  nome: 'Segmentos',
  descricao: 'Públicos salvos a partir de filtros de contatos.',
  entradas: [
    { metodo: 'GET', caminho: '/api/segments', resumo: 'Lista os segmentos salvos do espaço.' },
    { metodo: 'POST', caminho: '/api/segments', resumo: 'Salva um segmento: um nome e um filtro avançado de contatos.', corpo: segmentInputSchema, exemplo: { name: 'Clientes ativos', filter: { match: 'all', rules: [{ type: 'tag', tag_id: 'tag-cliente', operator: 'has' }] } } },
    { metodo: 'GET', caminho: '/api/segments/options', resumo: 'Opções para montar filtros: campos, tags, conexões e gatilhos do espaço.' },
    { metodo: 'GET', caminho: '/api/segments/:id', resumo: 'Mostra um segmento com o filtro.' },
    { metodo: 'PUT', caminho: '/api/segments/:id', resumo: 'Substitui o nome e o filtro de um segmento.', corpo: segmentInputSchema, exemplo: { name: 'Clientes ativos', filter: { match: 'any', rules: [{ type: 'channel', channel: 'whatsapp', operator: 'subscribed' }] } } },
    { metodo: 'DELETE', caminho: '/api/segments/:id', resumo: 'Exclui um segmento (os contatos não são tocados).' },
  ],
}
