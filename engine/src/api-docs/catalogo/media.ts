import type { AreaCatalogo } from '../tipos'
import { mediaUploadQuerySchema } from '../../media'

// Área media: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'media',
  nome: 'Mídia',
  descricao: 'Envio e leitura de arquivos usados nas mensagens.',
  entradas: [
    { metodo: 'POST', caminho: '/api/media', resumo: 'Envia um arquivo (corpo binário, com Content-Type e Content-Length) e devolve o id e o endereço para usar como anexo; com `connection_id` e `media`, confere o tipo e o tamanho que a conexão aceita.', query: mediaUploadQuerySchema, corpoBinario: true },
  ],
}
