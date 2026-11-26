import type { AreaCatalogo } from '../tipos'
import { sequenceInputSchema, sequenceWindowSchema } from '../../db/sequences'
import { z } from 'zod'

const numerosDeEnvio = z.object({
  sent: z.number().int(), delivered: z.number().int(), read: z.number().int(), clicked: z.number().int(),
  open_rate: z.number().describe('Lidas sobre entregues, em porcentagem (0 a 100).'),
  ctr: z.number().describe('Cliques sobre entregues, em porcentagem (0 a 100).'),
}).describe('Mensagens dos passos contadas uma vez por execução: enviadas, entregues, lidas e clicadas.')
const sequenciaResposta = z.object({
  id: z.string(),
  workspace_id: z.string(),
  name: z.string(),
  status: z.literal('active'),
  subscribers: z.number().int().describe('Contatos inscritos agora.'),
  stats: numerosDeEnvio,
  steps: z.array(z.object({
    id: z.string(),
    delay_seconds: z.number().int().describe('Espera, em segundos, depois do passo anterior (ou da inscrição, no primeiro).'),
    sending_time_settings: sequenceWindowSchema,
    status: z.enum(['live', 'draft']),
    automation_id: z.string().nullable(),
    stats: numerosDeEnvio,
  })).describe('Passos na ordem de envio.'),
})

// Área sequences: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'sequences',
  nome: 'Sequências',
  descricao: 'Séries de mensagens enviadas em dias e horários definidos.',
  entradas: [
    { metodo: 'GET', caminho: '/api/sequences', resumo: 'Lista as sequências com passos, assinantes e métricas de envio.', resposta: z.array(sequenciaResposta) },
    { metodo: 'POST', caminho: '/api/sequences', resumo: 'Cria uma sequência com seus passos (atraso, janela de envio e automação de cada um).', corpo: sequenceInputSchema, exemplo: { name: 'Boas-vindas', steps: [{ id: 'p1', delay_seconds: 86400, sending_time_settings: { type: 'all' }, status: 'live', automation_id: 'auto-dia-1' }] }, resposta: sequenciaResposta },
    { metodo: 'GET', caminho: '/api/sequences/flows', resumo: 'Lista as automações que podem ser usadas como passo de sequência.' },
    { metodo: 'GET', caminho: '/api/sequences/:id', resumo: 'Mostra uma sequência com passos e métricas.', resposta: sequenciaResposta },
    { metodo: 'PATCH', caminho: '/api/sequences/:id', resumo: 'Substitui o nome e os passos de uma sequência (mande a sequência inteira).', corpo: sequenceInputSchema, exemplo: { name: 'Boas-vindas', steps: [{ id: 'p1', delay_seconds: 3600, sending_time_settings: { type: 'timelimit', from: '09:00', to: '18:00', weekdays: [1, 2, 3, 4, 5] }, status: 'live', automation_id: 'auto-dia-1' }] } },
    { metodo: 'DELETE', caminho: '/api/sequences/:id', resumo: 'Exclui uma sequência e tira os contatos inscritos.' },
  ],
}
