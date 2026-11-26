import type { AreaCatalogo } from '../tipos'
import { broadcastAudienceContactsSchema, broadcastAudienceEstimateSchema, broadcastAudienceQuerySchema, broadcastListQuerySchema } from '../../broadcast-routes'
import { broadcastFromAutomationSchema, broadcastInput, broadcastTestSchema } from '../../db/broadcasts'
import { dataIso } from '../respostas-comuns'
import { z } from 'zod'

const audiencia = { tag: 'tag-cliente', channel: 'whatsapp', channel_id: 'ch-whatsapp' }

const transmissaoResposta = z.object({
  id: z.string(),
  workspace_id: z.string(),
  name: z.string(),
  content: z.string().describe('Texto da mensagem (o da primeira mensagem, quando o conteúdo é um fluxo).'),
  status: z.string().describe('`draft`, `scheduled`, `sending`, `paused`, `sent` ou `cancelled`.'),
  started: z.boolean().describe('O envio já começou alguma vez.'),
  audience: z.object({ channel: z.string(), channel_id: z.string() }).describe('Público, no formato de `audience` do corpo de `POST /api/broadcasts`.'),
  scheduled_at: dataIso('Envio agendado (ISO 8601, UTC); `null` sem agenda.').nullable(),
  scheduled_local: z.string().describe('A agenda como foi digitada, no fuso de `timezone`.'),
  timezone: z.string(),
  window_kind: z.enum(['automatic', 'in_window', 'promotional']),
  template: z.object({ id: z.string(), params: z.record(z.string(), z.string()) }).optional().describe('Modelo aprovado, quando a transmissão usa modelo.'),
  updated_at: dataIso(),
  pause_reason: z.string().nullable().describe('Por que o envio pausou (ex.: `token_refused`, com o detalhe em `pause_detail`).'),
  pause_detail: z.string().optional(),
  retry_at: dataIso('Quando o envio pausado tenta de novo sozinho (ISO 8601, UTC).').nullable(),
  stalled: z.object({ percent: z.number().int(), since: dataIso() }).nullable().describe('Envio parado há mais de 10 minutos: quanto já foi e desde quando.'),
  automation_id: z.string().nullable(),
  source_automation_id: z.string().nullable().describe('Automação de onde o conteúdo foi copiado.'),
  first_node_id: z.string().nullable(),
  flow: z.object({}).optional().describe('Conteúdo como fluxo (passos e ligações).'),
  metrics: z.object({
    total: z.number().int().describe('Destinatários registrados.'),
    sent: z.number().int(), queued: z.number().int(), skipped: z.number().int(),
    outside_window: z.number().int().describe('Pulados por estar fora da janela de resposta.'),
    failed: z.number().int(), uncertain: z.number().int().describe('Envio sem confirmação do provedor.'),
    delivered: z.number().int(), read: z.number().int(),
    clicked: z.number().int().describe('Contatos únicos que clicaram.'),
    ctr: z.number().describe('Cliques sobre contatos com envio, de 0 a 1.'),
  }).describe('Números de envio, por contato. Entregue e lida só aparecem em canal que avisa recibo.'),
})

export const area: AreaCatalogo = {
  area: 'broadcasts',
  nome: 'Transmissões',
  descricao: 'Mensagens enviadas de uma vez para um público, agora ou agendadas.',
  entradas: [
    { metodo: 'GET', caminho: '/api/broadcasts', resumo: 'Lista as transmissões do espaço (até 200, da alteração mais recente), com filtro por situação e busca por nome.', query: broadcastListQuerySchema, resposta: z.array(transmissaoResposta) },
    { metodo: 'POST', caminho: '/api/broadcasts', resumo: 'Cria ou atualiza (com `id`) uma transmissão: rascunho, agendada ou enviando já.', corpo: broadcastInput, exemplo: { name: 'Black Friday', content: 'Oi! Nossa oferta começou.', audience: audiencia, status: 'draft' } },
    { metodo: 'GET', caminho: '/api/broadcasts/:id', resumo: 'Mostra a transmissão com conteúdo, público, agenda, números de envio e os destinatários (até 200).', resposta: transmissaoResposta.extend({
      recipients: z.array(z.object({
        contact_channel_id: z.string(), contact_id: z.string(), name: z.string(),
        status: z.string().describe('`queued`, `sending`, `sent`, `skipped`, `failed` ou `uncertain`.'),
        reason: z.string().nullable().describe('Motivo do pulo ou da falha.'),
        sent_at: z.number().int().nullable().describe('Quando saiu, em milissegundos Unix.'),
      })),
    }) },
    { metodo: 'DELETE', caminho: '/api/broadcasts/:id', resumo: 'Exclui a transmissão.' },
    { metodo: 'POST', caminho: '/api/broadcasts/:id/cancel', resumo: 'Cancela a transmissão agendada ou em andamento.' },
    { metodo: 'POST', caminho: '/api/broadcasts/:id/pause', resumo: 'Pausa o envio da transmissão.' },
    { metodo: 'POST', caminho: '/api/broadcasts/:id/resume', resumo: 'Retoma o envio de uma transmissão pausada.' },
    { metodo: 'POST', caminho: '/api/broadcasts/:id/test', resumo: 'Envia a transmissão de teste para um contato. Responde `{ ok, test: true, conversation_id, message_id, parts }`: em `parts`, uma entrada por parte enviada com `external_id` (id da mensagem no provedor) e `status: "sent"` (aceita pelo provedor; entrega e leitura chegam depois como recibos na mensagem). O teste fica na conversa do contato com o texto começando por "[Teste da transmissão]" e consulta-se em `GET /api/inbox/conversations/{conversation_id}/messages`. Não cria destinatários nem muda as métricas.', corpo: broadcastTestSchema, exemplo: { contact_id: 'c1' } },
    { metodo: 'GET', caminho: '/api/broadcasts/audience', resumo: 'Estima quantos contatos o público escolhido alcança. Na query, `conditions` vai repetido (`conditions=tag&conditions=segment`) ou separado por vírgula (`conditions=tag,segment`).', query: broadcastAudienceQuerySchema, resposta: z.object({
      count: z.number().int().describe('Contatos únicos do público na conexão.'),
      eligible: z.number().int().describe('Desses, quantos podem receber agora (inscrição, consentimento e janela do canal).'),
    }) },
    { metodo: 'POST', caminho: '/api/broadcasts/audience', resumo: 'Estima o público considerando também o modelo e o tipo de janela de envio.', corpo: broadcastAudienceEstimateSchema, exemplo: { ...audiencia, window_kind: 'automatic' } },
    { metodo: 'POST', caminho: '/api/broadcasts/audience/contacts', resumo: 'Lista, paginados, os contatos que o público escolhido alcança.', corpo: broadcastAudienceContactsSchema, exemplo: { ...audiencia, page: 1, limit: 20 } },
    { metodo: 'GET', caminho: '/api/broadcasts/options', resumo: 'Opções para montar uma transmissão: conexões, tags, segmentos e modelos disponíveis.' },
    { metodo: 'POST', caminho: '/api/broadcasts/from-automation', resumo: 'Cria uma transmissão em rascunho copiando o fluxo de uma automação.', corpo: broadcastFromAutomationSchema, exemplo: { automation_id: 'auto-1', channel_id: 'ch-whatsapp' } },
  ],
}
