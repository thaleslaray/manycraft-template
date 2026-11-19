import type { AreaCatalogo } from '../tipos'

// Área workspaces: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'workspaces',
  nome: 'Espaços',
  descricao: 'Os espaços de trabalho de que você participa.',
  entradas: [
    { metodo: 'GET', caminho: '/api/workspaces/mine', resumo: 'Os espaços de que você participa, com seu papel, e qual é o atual.' },
  ],
}
