import type { AreaCatalogo } from '../tipos'
import { analyticsQuerySchema } from '../../db/insights'
import { z } from 'zod'

const inteiro = z.number().int()
const relatorioResposta = z.object({
  period: inteiro.describe('Dias no período.'),
  from: inteiro.describe('Início do período em segundos Unix.'),
  to: inteiro.describe('Fim do período em segundos Unix.'),
  points: z.array(z.object({
    date: z.string().describe('Dia em UTC, AAAA-MM-DD.'),
    contacts: inteiro.describe('Contatos únicos com atividade no dia.'),
    messages: inteiro.describe('Mensagens enviadas pela conta no dia.'),
    clicks: inteiro, new_contacts: inteiro, unsubscribed: inteiro,
    net: inteiro.describe('Novos menos descadastrados.'),
  })).describe('Um ponto por dia do período.'),
  totals: z.object({
    contacts: inteiro.describe('Contatos únicos ativos no período.'),
    messages: inteiro, clicks: inteiro,
    clickRate: z.number().nullable().describe('Cliques sobre mensagens, de 0 a 1; `null` sem mensagem.'),
    delivered: inteiro, read: inteiro, emails_collected: inteiro, new_contacts: inteiro, unsubscribed: inteiro, net: inteiro,
    inactive: inteiro.describe('Inscritos sem atividade no período.'),
    runs: inteiro.describe('Execuções de automação no período.'),
  }),
  automations: z.array(z.object({ id: z.string(), name: z.string(), contacts: inteiro, messages: inteiro, clicks: inteiro, conversions: inteiro, revenue: z.number() })).describe('Automações com atividade no período.'),
  by_channel: z.array(z.object({ channel: z.string(), contacts: inteiro, messages: inteiro })),
  conversions: z.object({
    events: z.array(z.object({ name: z.string(), count: inteiro })),
    revenue: z.array(z.object({ currency: z.string(), value: z.number() })),
  }),
  metadata: z.object({}).describe('Como os números foram contados (contatos únicos ativos, mensagens por passo enviado, fuso UTC).'),
})

// Área insights: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'insights',
  nome: 'Relatórios',
  descricao: 'Crescimento, mensagens e caixa de entrada por período.',
  entradas: [
    { metodo: 'GET', caminho: '/api/insights', resumo: 'Relatório de crescimento e mensagens por dia no período. `from` e `to` em segundos Unix (padrão: últimos 7 dias, no máximo 365 dias) e `channel` opcional. Dias em UTC.', query: analyticsQuerySchema, resposta: relatorioResposta },
    { metodo: 'GET', caminho: '/api/insights/inbox', resumo: 'Relatório da caixa de entrada no período (`from` e `to` em segundos Unix, padrão últimos 7 dias, no máximo 3 meses): conversas, respondidas e taxa de resposta.', query: analyticsQuerySchema },
  ],
}
