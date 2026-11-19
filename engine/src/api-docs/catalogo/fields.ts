import type { AreaCatalogo } from '../tipos'
import { fieldDeleteQuerySchema, fieldCreateSchema, fieldPatchSchema } from '../../settings'

// Área fields: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'fields',
  nome: 'Campos',
  descricao: 'Campos personalizados do contato e campos da conta.',
  entradas: [
    { metodo: 'GET', caminho: '/api/fields', resumo: 'Lista os campos personalizados: os do contato (`scope: contact`, um valor por contato) e os da conta (`scope: bot`, um valor só para o espaço inteiro).' },
    { metodo: 'POST', caminho: '/api/fields', resumo: 'Cria um campo do contato (`scope: contact`, padrão: um valor por contato) ou da conta (`scope: bot`: um valor só, guardado em `bot_value`, para o espaço inteiro).', corpo: fieldCreateSchema, exemplo: { name: 'Plano', type: 'text', scope: 'contact', description: 'Plano contratado.' } },
    { metodo: 'PATCH', caminho: '/api/fields/:id', resumo: 'Altera nome, descrição, valor do campo da conta (`bot_value`), pasta ou arquivamento de um campo (o tipo não muda).', corpo: fieldPatchSchema, exemplo: { name: 'Plano atual', archived: false } },
    { metodo: 'DELETE', caminho: '/api/fields/:id', resumo: 'Exclui um campo; se ele é usado em automação publicada, responde 409 com a lista até você mandar `confirm=true`.', query: fieldDeleteQuerySchema },
    { metodo: 'GET', caminho: '/api/fields/:id/usage', resumo: 'Lista as automações publicadas que usam o campo.' },
  ],
}
