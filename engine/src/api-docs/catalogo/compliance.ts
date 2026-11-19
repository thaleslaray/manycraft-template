import type { AreaCatalogo } from '../tipos'

// Área compliance: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'compliance',
  nome: 'Conformidade',
  descricao: 'Sinais de risco do espaço: conexões com erro, modelos rejeitados e taxas de bloqueio.',
  entradas: [
    { metodo: 'GET', caminho: '/api/compliance', resumo: 'Sinais de risco do espaço: conexões com erro, modelos rejeitados ou pausados e taxas de descadastro e falha dos últimos 7 dias.' },
  ],
}
