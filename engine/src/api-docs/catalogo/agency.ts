import type { AreaCatalogo } from '../tipos'
import { agencyProfileSchema } from '../../team'

// Área agency: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'agency',
  nome: 'Agência',
  descricao: 'Seu perfil de agência e os espaços de clientes que você administra.',
  entradas: [
    { metodo: 'GET', caminho: '/api/agency', resumo: 'Seu perfil de agência e os espaços que você administra, com contatos, automações no ar e conexões.' },
    { metodo: 'PUT', caminho: '/api/agency', resumo: 'Cria ou altera seu perfil de agência (nome e site).', corpo: agencyProfileSchema, exemplo: { name: 'Agência Exemplo', website: 'https://exemplo.com' } },
  ],
}
