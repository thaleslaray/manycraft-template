import type { AreaCatalogo } from '../tipos'
import { analyticsQuerySchema } from '../../db/insights'

// Área dashboard: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'dashboard',
  nome: 'Painel inicial',
  descricao: 'Números do resumo da tela inicial por período.',
  entradas: [
    { metodo: 'GET', caminho: '/api/dashboard', resumo: 'Números do painel inicial no período (`from` e `to` em segundos Unix, padrão últimos 7 dias, até 365 dias; `channel` opcional).', query: analyticsQuerySchema },
  ],
}
