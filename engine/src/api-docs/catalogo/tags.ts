import type { AreaCatalogo } from '../tipos'
import { tagCreateSchema, tagPatchSchema } from '../../settings'

// Área tags: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'tags',
  nome: 'Tags',
  descricao: 'Etiquetas para marcar e separar contatos.',
  entradas: [
    { metodo: 'GET', caminho: '/api/tags', resumo: 'Lista as tags do espaço.' },
    { metodo: 'POST', caminho: '/api/tags', resumo: 'Cria uma tag, opcionalmente numa pasta.', corpo: tagCreateSchema, exemplo: { name: 'Cliente', folder_id: null } },
    { metodo: 'PATCH', caminho: '/api/tags/:id', resumo: 'Renomeia, muda de pasta ou arquiva uma tag.', corpo: tagPatchSchema, exemplo: { name: 'Cliente VIP' } },
    { metodo: 'DELETE', caminho: '/api/tags/:id', resumo: 'Exclui uma tag e a tira dos contatos.' },
  ],
}
