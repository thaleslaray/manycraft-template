import type { AreaCatalogo } from '../tipos'
import { contactImportSchema } from '../../contact-imports'

// Área contact-imports: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'contact-imports',
  nome: 'Importação de contatos',
  descricao: 'Importar contatos de planilha e acompanhar a importação.',
  entradas: [
    { metodo: 'POST', caminho: '/api/contact-imports', resumo: 'Importa contatos de um CSV (até 1 MB) com o mapa de colunas; roda em fila e devolve o relatório inicial.', corpo: contactImportSchema, exemplo: { file_name: 'contatos.csv', csv: 'nome,email\nAna,ana@exemplo.com', consent: true, tag_ids: [], mapping: { first_name: 0, email: 1 } } },
    { metodo: 'GET', caminho: '/api/contact-imports/:id', resumo: 'Relatório da importação: situação, criados, atualizados e linhas ignoradas com o motivo.' },
    { metodo: 'POST', caminho: '/api/contact-imports/:id/retry', resumo: 'Retoma uma importação que falhou.' },
  ],
}
