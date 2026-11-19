import type { AreaCatalogo } from '../tipos'
import { analyticsQuerySchema } from '../../db/insights'

// Área insights: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'insights',
  nome: 'Relatórios',
  descricao: 'Crescimento, mensagens e caixa de entrada por período.',
  entradas: [
    { metodo: 'GET', caminho: '/api/insights', resumo: 'Relatório de crescimento e mensagens por dia no período. `from` e `to` em segundos Unix (padrão: últimos 7 dias, no máximo 365 dias) e `channel` opcional.', query: analyticsQuerySchema },
    { metodo: 'GET', caminho: '/api/insights/inbox', resumo: 'Relatório da caixa de entrada no período (`from` e `to` em segundos Unix): conversas, respondidas e taxa de resposta.', query: analyticsQuerySchema },
  ],
}
