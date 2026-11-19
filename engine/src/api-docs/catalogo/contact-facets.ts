import type { AreaCatalogo } from '../tipos'

// Área contact-facets: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'contact-facets',
  nome: 'Contagens de contatos',
  descricao: 'Quantos contatos cada gatilho trouxe e quantos estão em cada sequência.',
  entradas: [
    { metodo: 'GET', caminho: '/api/contact-facets', resumo: 'Quantos contatos cada gatilho trouxe e quantos estão em cada sequência.' },
  ],
}
