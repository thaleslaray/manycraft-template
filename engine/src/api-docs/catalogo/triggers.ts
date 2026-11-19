import type { AreaCatalogo } from '../tipos'
import { triggerFollowUpSchema, triggerOptInStatusSchema, triggerReplaceSchema } from '../../triggers-overview'

// Área triggers: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'triggers',
  nome: 'Gatilhos',
  descricao: 'Gatilhos que iniciam automações (comentário, link, anúncio...).',
  entradas: [
    { metodo: 'GET', caminho: '/api/triggers/:id', resumo: 'Mostra o gatilho: tipo, conexão, situação, a automação que dispara hoje, inscrição e follow-up.' },
    { metodo: 'PUT', caminho: '/api/triggers/:id/follow-up', resumo: 'Define o follow-up: após X minutos sem resposta do contato, começa a automação escolhida (`null` desliga).', corpo: triggerFollowUpSchema, exemplo: { follow_up: { after_minutes: 60, automation_id: 'auto-lembrete' } } },
    { metodo: 'PUT', caminho: '/api/triggers/:id/opt-in-status', resumo: 'Diz se quem entra pelo gatilho fica inscrito (`subscribe`) ou fora das transmissões (`do_not_send`).', corpo: triggerOptInStatusSchema, exemplo: { opt_in_status: 'subscribe' } },
    { metodo: 'POST', caminho: '/api/triggers/:id/replace', resumo: 'Faz o gatilho disparar outra automação publicada, mantendo histórico e frequência.', corpo: triggerReplaceSchema, exemplo: { automation_id: 'auto-2' } },
    { metodo: 'GET', caminho: '/api/triggers/overview', resumo: 'Visão geral de todos os gatilhos do espaço por família, com ativos, total e execuções em 30 dias.' },
  ],
}
