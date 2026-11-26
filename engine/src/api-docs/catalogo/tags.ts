import type { AreaCatalogo } from '../tipos'
import { tagCreateSchema, tagPatchSchema } from '../../settings'
import { tagResposta } from '../respostas-comuns'
import { z } from 'zod'

const tagDaListaResposta = tagResposta.extend({
  archived: z.boolean(),
  folder_id: z.string().nullable().describe('Pasta da tag (`GET /api/settings-folders?kind=tags`); `null` = sem pasta.'),
})

// Área tags: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'tags',
  nome: 'Tags',
  descricao: 'Etiquetas para marcar e separar contatos.',
  entradas: [
    { metodo: 'GET', caminho: '/api/tags', resumo: 'Lista as tags do espaço, em ordem de nome, com quantos contatos cada uma tem.', resposta: z.array(tagDaListaResposta) },
    { metodo: 'POST', caminho: '/api/tags', resumo: 'Cria uma tag, opcionalmente numa pasta.', corpo: tagCreateSchema, exemplo: { name: 'Cliente', folder_id: null }, resposta: tagDaListaResposta },
    { metodo: 'PATCH', caminho: '/api/tags/:id', resumo: 'Renomeia, muda de pasta ou arquiva uma tag.', corpo: tagPatchSchema, exemplo: { name: 'Cliente VIP' } },
    { metodo: 'DELETE', caminho: '/api/tags/:id', resumo: 'Exclui uma tag e a tira dos contatos.' },
  ],
}
