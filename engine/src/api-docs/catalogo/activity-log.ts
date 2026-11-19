import type { AreaCatalogo } from '../tipos'

// Área activity-log: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'activity-log',
  nome: 'Registro de atividades',
  descricao: 'As alterações feitas no espaço, por quem e se vieram do painel ou da API.',
  entradas: [
    { metodo: 'GET', caminho: '/api/activity-log', resumo: 'As 200 alterações mais recentes no espaço: rota, resultado, quem fez e se veio do painel ou de chave de API.' },
  ],
}
