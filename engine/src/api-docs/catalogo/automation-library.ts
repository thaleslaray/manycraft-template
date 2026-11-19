import type { AreaCatalogo } from '../tipos'
import { automationLibraryQuerySchema } from '../../automation-library'

// Área automation-library: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'automation-library',
  nome: 'Biblioteca de automações',
  descricao: 'Automações prontas para copiar para o espaço.',
  entradas: [
    { metodo: 'GET', caminho: '/api/automation-library', resumo: 'Biblioteca de automações com pastas, lixeira e filtros por status, tipo e situação do gatilho, paginada por cursor.', query: automationLibraryQuerySchema },
  ],
}
