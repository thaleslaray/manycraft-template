import type { AreaCatalogo } from '../tipos'
import { folderCreateSchema, folderDeleteQuerySchema, folderPatchSchema } from '../../automation-library'
import { dataIso } from '../respostas-comuns'
import { z } from 'zod'

// Área folders: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'folders',
  nome: 'Pastas de automações',
  descricao: 'Pastas que organizam as automações.',
  entradas: [
    { metodo: 'GET', caminho: '/api/folders', resumo: 'Lista as pastas de automações (com quantas automações cada uma tem) e diz se você pode editá-las.', resposta: z.object({
      folders: z.array(z.object({
        id: z.string(), workspace_id: z.string(),
        parent_id: z.string().nullable().describe('Pasta-mãe; `null` = na raiz.'),
        name: z.string(), created_at: dataIso(),
        count: z.number().int().describe('Automações fora da lixeira nesta pasta.'),
      })),
      total: z.number().int().describe('Automações fora da lixeira.'),
      unfiled: z.number().int().describe('Automações sem pasta.'),
      trashed: z.number().int().describe('Automações na lixeira.'),
      can_edit: z.boolean(),
    }) },
    { metodo: 'POST', caminho: '/api/folders', resumo: 'Cria uma pasta de automações, opcionalmente dentro de outra.', corpo: folderCreateSchema, exemplo: { name: 'Lançamento', parent_id: null } },
    { metodo: 'PATCH', caminho: '/api/folders/:id', resumo: 'Renomeia ou move uma pasta de automações.', corpo: folderPatchSchema, exemplo: { name: 'Lançamento 2026' } },
    { metodo: 'DELETE', caminho: '/api/folders/:id', resumo: 'Exclui uma pasta; com `move_items=1` as automações dela vão para Sem pasta.', query: folderDeleteQuerySchema },
  ],
}
