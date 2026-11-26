import type { AreaCatalogo } from '../tipos'
import { analyticsQuerySchema } from '../../db/insights'
import { dataIso } from '../respostas-comuns'
import { z } from 'zod'

const painelResposta = z.object({
  reference_at: dataIso('Momento do cálculo (ISO 8601, UTC).'),
  period_days: z.number().int(),
  from: z.number().int().describe('Início do período em segundos Unix.'),
  to: z.number().int().describe('Fim do período em segundos Unix.'),
  metrics: z.array(z.object({
    key: z.enum(['contacts', 'new_contacts', 'open_conversations', 'live_automations']),
    label: z.string(),
    value: z.number().int(),
    delta: z.number().int().nullable().describe('Variação (o que `comparison` diz); `null` sem histórico comparável.'),
    comparison: z.string(),
  })).describe('Cartões: contatos na base, novos contatos, conversas abertas com atividade no período e automações ligadas.'),
  most_used: z.array(z.object({ id: z.string(), name: z.string(), status: z.enum(['draft', 'live', 'stopped']), runs: z.number().int(), unique_contacts: z.number().int() })).describe('As 5 automações com mais execuções no período.'),
  most_engaged: z.array(z.object({ contact_id: z.string(), name: z.string(), messages: z.number().int() })).describe('Os 5 contatos que mais mandaram mensagem no período.'),
  time_saved: z.object({
    minutes: z.number().int().describe('Mensagens automáticas enviadas no período, a 1 minuto de atendimento cada.'),
    by_type: z.array(z.object({ type: z.enum(['dm', 'comment', 'story', 'other']), messages: z.number().int() })),
  }),
  checklist: z.array(z.object({ key: z.enum(['connect', 'automation', 'publish', 'first_contact', 'team']), label: z.string(), done: z.boolean() })).describe('Primeiros passos, pelo estado real do espaço.'),
  channels: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), status: z.string() })).describe('Conexões (até 20) com o estado atual.'),
  empty: z.boolean().describe('Espaço sem contatos nem automações.'),
})

// Área dashboard: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'dashboard',
  nome: 'Painel inicial',
  descricao: 'Números do resumo da tela inicial por período.',
  entradas: [
    { metodo: 'GET', caminho: '/api/dashboard', resumo: 'Números do painel inicial no período (`from` e `to` em segundos Unix, padrão últimos 7 dias, até 365 dias; `channel` opcional).', query: analyticsQuerySchema, resposta: painelResposta },
  ],
}
