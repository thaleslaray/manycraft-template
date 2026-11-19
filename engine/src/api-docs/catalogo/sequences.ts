import type { AreaCatalogo } from '../tipos'
import { sequenceInputSchema } from '../../db/sequences'

// Área sequences: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'sequences',
  nome: 'Sequências',
  descricao: 'Séries de mensagens enviadas em dias e horários definidos.',
  entradas: [
    { metodo: 'GET', caminho: '/api/sequences', resumo: 'Lista as sequências com passos, assinantes e métricas de envio.' },
    { metodo: 'POST', caminho: '/api/sequences', resumo: 'Cria uma sequência com seus passos (atraso, janela de envio e automação de cada um).', corpo: sequenceInputSchema, exemplo: { name: 'Boas-vindas', steps: [{ id: 'p1', delay_seconds: 86400, sending_time_settings: { type: 'all' }, status: 'live', automation_id: 'auto-dia-1' }] } },
    { metodo: 'GET', caminho: '/api/sequences/flows', resumo: 'Lista as automações que podem ser usadas como passo de sequência.' },
    { metodo: 'GET', caminho: '/api/sequences/:id', resumo: 'Mostra uma sequência com passos e métricas.' },
    { metodo: 'PATCH', caminho: '/api/sequences/:id', resumo: 'Substitui o nome e os passos de uma sequência (mande a sequência inteira).', corpo: sequenceInputSchema, exemplo: { name: 'Boas-vindas', steps: [{ id: 'p1', delay_seconds: 3600, sending_time_settings: { type: 'timelimit', from: '09:00', to: '18:00', weekdays: [1, 2, 3, 4, 5] }, status: 'live', automation_id: 'auto-dia-1' }] } },
    { metodo: 'DELETE', caminho: '/api/sequences/:id', resumo: 'Exclui uma sequência e tira os contatos inscritos.' },
  ],
}
