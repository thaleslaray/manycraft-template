import type { AreaCatalogo } from '../tipos'
import { templateDraftSchema } from '../../channels/template-draft'

const exemplo = { name: 'pedido_enviado', category: 'utility', language: 'pt_BR', header: { type: 'none' }, body: 'Olá {{1}}, seu pedido saiu para entrega.', examples: { '1': 'Ana' }, footer: '', buttons: [] }

// Área message-templates: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'message-templates',
  nome: 'Modelos de mensagem',
  descricao: 'Modelos de mensagem aprovados pelo canal (ex.: WhatsApp).',
  entradas: [
    { metodo: 'GET', caminho: '/api/message-templates/options', resumo: 'Lista as conexões que têm modelos de mensagem e diz se você pode editar e sincronizar. `canSync` só é verdadeiro com token e ID da conta do WhatsApp Business (WABA) salvos.' },
    { metodo: 'GET', caminho: '/api/message-templates/:connection', resumo: 'Lista os modelos de mensagem da conexão, com status de revisão e qualidade.' },
    { metodo: 'POST', caminho: '/api/message-templates/:connection', resumo: 'Cria um rascunho de modelo de mensagem na conexão (nome e idioma únicos).', corpo: templateDraftSchema, exemplo },
    { metodo: 'GET', caminho: '/api/message-templates/:connection/analytics', resumo: 'Resultados de cada modelo: transmissões, envios, falhas, ignorados, cliques e taxa de cliques.' },
    { metodo: 'POST', caminho: '/api/message-templates/:connection/sync', resumo: 'Atualiza os modelos com o provedor: status de revisão e importação dos criados direto lá. Sem o ID da conta do WhatsApp Business (WABA) salvo: 409 pedindo para informá-lo em Trocar credencial (`POST /api/connections/:id/rotate` com `wabaId`).' },
    { metodo: 'PATCH', caminho: '/api/message-templates/:connection/:id', resumo: 'Edita um rascunho de modelo (depois de enviado para revisão, fica travado).', corpo: templateDraftSchema, exemplo },
    { metodo: 'POST', caminho: '/api/message-templates/:connection/:id/submit', resumo: 'Envia o rascunho para revisão do provedor. Sem o ID da conta do WhatsApp Business (WABA) salvo: 409 e o rascunho continua editável.' },
  ],
}
