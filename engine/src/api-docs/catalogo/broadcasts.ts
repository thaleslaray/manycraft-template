import type { AreaCatalogo } from '../tipos'
import { broadcastAudienceContactsSchema, broadcastAudienceEstimateSchema, broadcastAudienceQuerySchema, broadcastListQuerySchema } from '../../broadcast-routes'
import { broadcastFromAutomationSchema, broadcastInput, broadcastTestSchema } from '../../db/broadcasts'

const audiencia = { tag: 'tag-cliente', channel: 'whatsapp', channel_id: 'ch-whatsapp' }

export const area: AreaCatalogo = {
  area: 'broadcasts',
  nome: 'Transmissões',
  descricao: 'Mensagens enviadas de uma vez para um público, agora ou agendadas.',
  entradas: [
    { metodo: 'GET', caminho: '/api/broadcasts', resumo: 'Lista as transmissões do espaço, com filtro por situação e busca por nome.', query: broadcastListQuerySchema },
    { metodo: 'POST', caminho: '/api/broadcasts', resumo: 'Cria ou atualiza (com `id`) uma transmissão: rascunho, agendada ou enviando já.', corpo: broadcastInput, exemplo: { name: 'Black Friday', content: 'Oi! Nossa oferta começou.', audience: audiencia, status: 'draft' } },
    { metodo: 'GET', caminho: '/api/broadcasts/:id', resumo: 'Mostra a transmissão com conteúdo, público, agenda e números de envio.' },
    { metodo: 'DELETE', caminho: '/api/broadcasts/:id', resumo: 'Exclui a transmissão.' },
    { metodo: 'POST', caminho: '/api/broadcasts/:id/cancel', resumo: 'Cancela a transmissão agendada ou em andamento.' },
    { metodo: 'POST', caminho: '/api/broadcasts/:id/pause', resumo: 'Pausa o envio da transmissão.' },
    { metodo: 'POST', caminho: '/api/broadcasts/:id/resume', resumo: 'Retoma o envio de uma transmissão pausada.' },
    { metodo: 'POST', caminho: '/api/broadcasts/:id/test', resumo: 'Envia a transmissão de teste para um contato. Responde `{ ok, test: true, conversation_id, message_id, parts }`: em `parts`, uma entrada por parte enviada com `external_id` (id da mensagem no provedor) e `status: "sent"` (aceita pelo provedor; entrega e leitura chegam depois como recibos na mensagem). O teste fica na conversa do contato com o texto começando por "[Teste da transmissão]" e consulta-se em `GET /api/inbox/conversations/{conversation_id}/messages`. Não cria destinatários nem muda as métricas.', corpo: broadcastTestSchema, exemplo: { contact_id: 'c1' } },
    { metodo: 'GET', caminho: '/api/broadcasts/audience', resumo: 'Estima quantos contatos o público escolhido alcança. Na query, `conditions` vai repetido (`conditions=tag&conditions=segment`) ou separado por vírgula (`conditions=tag,segment`).', query: broadcastAudienceQuerySchema },
    { metodo: 'POST', caminho: '/api/broadcasts/audience', resumo: 'Estima o público considerando também o modelo e o tipo de janela de envio.', corpo: broadcastAudienceEstimateSchema, exemplo: { ...audiencia, window_kind: 'automatic' } },
    { metodo: 'POST', caminho: '/api/broadcasts/audience/contacts', resumo: 'Lista, paginados, os contatos que o público escolhido alcança.', corpo: broadcastAudienceContactsSchema, exemplo: { ...audiencia, page: 1, limit: 20 } },
    { metodo: 'GET', caminho: '/api/broadcasts/options', resumo: 'Opções para montar uma transmissão: conexões, tags, segmentos e modelos disponíveis.' },
    { metodo: 'POST', caminho: '/api/broadcasts/from-automation', resumo: 'Cria uma transmissão em rascunho copiando o fluxo de uma automação.', corpo: broadcastFromAutomationSchema, exemplo: { automation_id: 'auto-1', channel_id: 'ch-whatsapp' } },
  ],
}
