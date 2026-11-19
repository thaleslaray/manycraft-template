import type { AreaCatalogo } from '../tipos'
import { folderCreateSchema, folderDeleteQuerySchema, folderPatchSchema } from '../../automation-library'

// Área folders: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'folders',
  nome: 'Pastas de automações',
  descricao: 'Pastas que organizam as automações.',
  entradas: [
    { metodo: 'GET', caminho: '/api/folders', resumo: 'Lista as pastas de automações e diz se você pode editá-las.' },
    { metodo: 'POST', caminho: '/api/folders', resumo: 'Cria uma pasta de automações, opcionalmente dentro de outra.', corpo: folderCreateSchema, exemplo: { name: 'Lançamento', parent_id: null } },
    { metodo: 'PATCH', caminho: '/api/folders/:id', resumo: 'Renomeia ou move uma pasta de automações.', corpo: folderPatchSchema, exemplo: { name: 'Lançamento 2026' } },
    { metodo: 'DELETE', caminho: '/api/folders/:id', resumo: 'Exclui uma pasta; com `move_items=1` as automações dela vão para Sem pasta.', query: folderDeleteQuerySchema },
  ],
}
