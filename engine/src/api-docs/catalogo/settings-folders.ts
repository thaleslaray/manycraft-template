import type { AreaCatalogo } from '../tipos'
import { settingsFolderCreateSchema, settingsFolderListQuerySchema, settingsFolderPatchSchema } from '../../settings'

// Área settings-folders: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'settings-folders',
  nome: 'Pastas de tags e campos',
  descricao: 'Pastas que organizam tags e campos.',
  entradas: [
    { metodo: 'GET', caminho: '/api/settings-folders', resumo: 'Lista as pastas de campos (`kind=fields`) ou de tags (`kind=tags`).', query: settingsFolderListQuerySchema },
    { metodo: 'POST', caminho: '/api/settings-folders', resumo: 'Cria uma pasta para organizar campos ou tags.', corpo: settingsFolderCreateSchema, exemplo: { name: 'Vendas', kind: 'tags' } },
    { metodo: 'PATCH', caminho: '/api/settings-folders/:id', resumo: 'Renomeia uma pasta de campos ou tags.', corpo: settingsFolderPatchSchema, exemplo: { name: 'Vendas 2026' } },
    { metodo: 'DELETE', caminho: '/api/settings-folders/:id', resumo: 'Exclui uma pasta de campos ou tags.' },
  ],
}
