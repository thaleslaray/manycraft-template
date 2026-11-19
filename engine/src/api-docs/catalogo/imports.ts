import type { AreaCatalogo } from '../tipos'
import { manychatImportSchema, manychatSharedImportSchema } from '../../manychat-import'

// Área imports: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'imports',
  nome: 'Importação da ManyChat',
  descricao: 'Trazer fluxos copiados da ManyChat para automações.',
  entradas: [
    { metodo: 'POST', caminho: '/api/imports/manychat', resumo: 'Importa um fluxo copiado da ManyChat (área de transferência, até 4 MB) como automação, criando ou reaproveitando tags, campos e sequências.', corpo: manychatImportSchema },
    { metodo: 'POST', caminho: '/api/imports/manychat/fragment', resumo: 'Traduz blocos copiados da ManyChat num pedaço de fluxo, sem criar automação. O resultado é para colar numa automação aberta.', corpo: manychatImportSchema },
    { metodo: 'POST', caminho: '/api/imports/manychat/shared', resumo: 'Importa um fluxo pelo link de compartilhamento da ManyChat, com os gatilhos que dá para recriar.', corpo: manychatSharedImportSchema, exemplo: { share_url: 'https://app.manychat.com/sharing/abc123', name: 'Fluxo importado' } },
  ],
}
