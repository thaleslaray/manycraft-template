import type { AreaCatalogo } from '../tipos'
import { inboxAssignSchema, inboxConversationListQuerySchema, inboxMessageListQuerySchema, inboxMessageSchema, inboxReminderSchema, inboxResumeAutomationsSchema, inboxRunAutomationSchema, inboxScheduledSchema, inboxStatusSchema } from '../../inbox/routes'
import { inboxConversationLabelSchema, inboxLabelSchema } from '../../inbox/labels'
import { inboxAssignmentRulesSchema, inboxAssignmentSchema, inboxGroupSchema, inboxSavedReplySchema, inboxSettingsSchema } from '../../inbox/team'
import { startSchema } from '../../channels/core/start-conversation'
import { conversaResposta, dataIso } from '../respostas-comuns'
import { z } from 'zod'

const mensagemResposta = z.object({
  id: z.string(),
  conversation_id: z.string(),
  direction: z.enum(['in', 'out']).describe('`in` do contato, `out` da conta (automação, equipe, nota ou evento).'),
  sender: z.enum(['contact', 'automation', 'human', 'note', 'system']).describe('`note` é nota interna (o contato não vê); `system` é evento do histórico (veja `event`).'),
  text: z.string(),
  created_at: dataIso(),
  status: z.string().describe('Situação do envio: `sent`, `delivered`, `read` ou `failed` (com o motivo em `error`).'),
  error: z.string().optional(),
  template: z.object({ id: z.string(), params: z.record(z.string(), z.string()) }).optional().describe('Modelo aprovado enviado nesta mensagem.'),
  buttons: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
  event: z.object({ kind: z.string() }).optional().describe('Evento do histórico (`tag_added`, `tag_removed`, `field_changed`, `trigger`, `status_changed`, `automation_paused`...), com os dados próprios do tipo.'),
  media: z.object({}).optional().describe('Anexo que o contato mandou; `url` (caminho nesta API) abre o arquivo guardado.'),
  email_subject: z.string().optional(),
  sequence: z.number().int().optional().describe('Ordem da mensagem na conversa.'),
})
const etiquetaResposta = z.object({
  id: z.string(),
  name: z.string(),
  color: z.enum(['neutral', 'accent', 'success', 'warning', 'danger']),
  condition: z.object({}).nullable().describe('Filtro de contato (formato de `POST /api/contacts/query`) que põe a etiqueta sozinha; `null` = só manual.'),
  conversations: z.number().int().describe('Conversas com a etiqueta.'),
})

// Área inbox: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'inbox',
  nome: 'Caixa de entrada',
  descricao: 'Conversas ao vivo com os contatos: mensagens, responsáveis e status.',
  entradas: [
    { metodo: 'GET', caminho: '/api/inbox/assignment', resumo: 'Mostra a atribuição automática de conversas: modo e limite por atendente.' },
    { metodo: 'PUT', caminho: '/api/inbox/assignment', resumo: 'Define o modo de atribuição automática (desligada, básica ou por regras) e o limite de conversas por atendente.', corpo: inboxAssignmentSchema, exemplo: { auto_assign: 'basic', assign_limit: 20 } },
    { metodo: 'GET', caminho: '/api/inbox/assignment-rules', resumo: 'Lista, em ordem, as regras de atribuição: condição sobre o contato e destino (atendente ou grupo).' },
    { metodo: 'PUT', caminho: '/api/inbox/assignment-rules', resumo: 'Substitui a lista inteira de regras de atribuição (até 50, aplicadas na ordem enviada).', corpo: inboxAssignmentRulesSchema, exemplo: [{ name: 'Clientes para o suporte', condition: { match: 'all', rules: [{ type: 'tag', tag_id: 'tag-cliente', operator: 'has' }] }, target_kind: 'member', target_id: 'membro-1' }] },
    { metodo: 'GET', caminho: '/api/inbox/context', resumo: 'Dados de apoio da caixa de entrada: quem é você, atendentes, contagem de abertas, suas e menções não lidas.' },
    { metodo: 'POST', caminho: '/api/inbox/contacts/:contactId/conversation', resumo: 'Abre (ou reaproveita) a conversa com o contato pela conexão por onde ele falou por último e devolve o id.' },
    { metodo: 'GET', caminho: '/api/inbox/conversations', resumo: 'Lista as conversas por situação (abertas, fechadas ou todas), com paginação por cursor e filtro opcional de contato (JSON em `contact_filter`). Até 50 por página, da atividade mais recente para a mais antiga; `next_cursor` vai em `cursor`.', query: inboxConversationListQuerySchema, resposta: z.object({ rows: z.array(conversaResposta), next_cursor: z.string().nullable().describe('Mande em `cursor` para a próxima página; `null` na última.') }) },
    { metodo: 'POST', caminho: '/api/inbox/conversations', resumo: 'Inicia conversa com um número que nunca escreveu, enviando um modelo aprovado depois de confirmar o consentimento.', corpo: startSchema, exemplo: { connection_id: 'ch-whatsapp', phone: '+5511912345678', name: 'Ana', consent: true, template: { id: 'boas-vindas', params: { '1': 'Ana' } } } },
    { metodo: 'POST', caminho: '/api/inbox/conversations/:id/assign', resumo: 'Atribui a conversa a um atendente com acesso à caixa de entrada (`null` tira a atribuição).', corpo: inboxAssignSchema, exemplo: { member_id: 'membro-1' } },
    { metodo: 'POST', caminho: '/api/inbox/conversations/:id/labels', resumo: 'Põe ou tira uma etiqueta da conversa.', corpo: inboxConversationLabelSchema, exemplo: { label_id: 'etiqueta-vip', on: true }, resposta: conversaResposta },
    { metodo: 'GET', caminho: '/api/inbox/conversations/:id/messages', resumo: 'Lista as mensagens da conversa: as 50 mais recentes, em ordem de envio (a mais antiga primeiro); para as anteriores, mande o `next_before` em `before`. O que a automação enviou vem em `text` como o contato viu: a galeria com o texto de abertura e uma linha por cartão, a lista com corpo, `[botão]` e linhas, o modelo como `[Modelo: nome]` seguido do texto com as variáveis preenchidas; botões de resposta de cartões e linhas de lista vêm em `buttons`. O evento de início (`event.kind: "trigger"`) traz em `trigger_kind` o tipo do gatilho, `manual` quando a equipe rodou a automação pelo inbox e `another_flow` quando outra automação a iniciou.', query: inboxMessageListQuerySchema, resposta: z.object({ rows: z.array(mensagemResposta), next_before: z.string().nullable().describe('Mande em `before` para a página anterior; `null` quando não há mais.') }) },
    { metodo: 'POST', caminho: '/api/inbox/conversations/:id/messages', resumo: 'Responde na conversa com texto, anexo enviado antes (POST /api/media) ou modelo aprovado, ou grava uma nota interna com menções. Recusas 409 com motivo: janela de atendimento encerrada (responda com modelo aprovado), contato sem autorização para modelos, canal indisponível.', corpo: inboxMessageSchema, exemplo: { kind: 'reply', text: 'Oi! Já vou verificar seu pedido.' } },
    { metodo: 'POST', caminho: '/api/inbox/conversations/:id/read', resumo: 'Marca a conversa como lida.' },
    { metodo: 'POST', caminho: '/api/inbox/conversations/:id/reminder', resumo: 'Define um lembrete na conversa (até um ano à frente, com nota opcional); `at: null` tira o lembrete.', corpo: inboxReminderSchema, exemplo: { at: '2026-12-01T09:00:00-03:00', note: 'Retornar sobre o orçamento.' } },
    { metodo: 'POST', caminho: '/api/inbox/conversations/:id/resume-automations', resumo: 'Tira a pausa das automações do contato da conversa e avisa os fluxos que estavam esperando (corpo vazio ou `{}`).', corpo: inboxResumeAutomationsSchema, exemplo: {} },
    { metodo: 'POST', caminho: '/api/inbox/conversations/:id/run-automation', resumo: 'Roda uma automação publicada e ligada para o contato da conversa. O início entra no histórico com `trigger_kind: "manual"`.', corpo: inboxRunAutomationSchema, exemplo: { automation_id: 'auto-boas-vindas' } },
    { metodo: 'GET', caminho: '/api/inbox/conversations/:id/scheduled', resumo: 'Lista as mensagens agendadas da conversa (as que vão sair e as últimas enviadas ou com falha).' },
    { metodo: 'POST', caminho: '/api/inbox/conversations/:id/scheduled', resumo: 'Agenda uma mensagem de texto na conversa, de 1 minuto a 30 dias à frente.', corpo: inboxScheduledSchema, exemplo: { text: 'Bom dia! Passando para confirmar sua visita.', send_at: '2026-12-01T09:00:00-03:00' } },
    { metodo: 'DELETE', caminho: '/api/inbox/conversations/:id/scheduled/:scheduledId', resumo: 'Cancela uma mensagem agendada que ainda não saiu (só quem agendou ou um administrador).' },
    { metodo: 'POST', caminho: '/api/inbox/conversations/:id/status', resumo: 'Abre ou fecha a conversa pelo campo `status` (`open` ou `closed`).', corpo: inboxStatusSchema, exemplo: { status: 'closed' } },
    { metodo: 'POST', caminho: '/api/inbox/conversations/:id/unread', resumo: 'Marca a conversa como não lida.' },
    { metodo: 'GET', caminho: '/api/inbox/groups', resumo: 'Lista os grupos de atendentes, com os membros de cada um.' },
    { metodo: 'POST', caminho: '/api/inbox/groups', resumo: 'Cria um grupo de atendentes.', corpo: inboxGroupSchema, exemplo: { name: 'Vendas', member_ids: ['membro-1', 'membro-2'] } },
    { metodo: 'PUT', caminho: '/api/inbox/groups/:id', resumo: 'Renomeia o grupo e substitui os membros.', corpo: inboxGroupSchema, exemplo: { name: 'Vendas', member_ids: ['membro-1'] } },
    { metodo: 'DELETE', caminho: '/api/inbox/groups/:id', resumo: 'Exclui o grupo e as regras de atribuição que apontavam para ele.' },
    { metodo: 'GET', caminho: '/api/inbox/labels', resumo: 'Lista as etiquetas de conversa, com a condição automática e quantas conversas têm cada uma.', resposta: z.array(etiquetaResposta) },
    { metodo: 'POST', caminho: '/api/inbox/labels', resumo: 'Cria uma etiqueta de conversa; com `condition`, ela é posta sozinha quando o contato atende ao filtro.', corpo: inboxLabelSchema, exemplo: { name: 'VIP', color: 'accent' }, resposta: z.object({ id: z.string().describe('Id da etiqueta criada.') }) },
    { metodo: 'PUT', caminho: '/api/inbox/labels/:id', resumo: 'Altera nome, cor ou condição da etiqueta.', corpo: inboxLabelSchema, exemplo: { name: 'VIP', color: 'success' } },
    { metodo: 'DELETE', caminho: '/api/inbox/labels/:id', resumo: 'Exclui a etiqueta e a tira das conversas.' },
    { metodo: 'GET', caminho: '/api/inbox/media/:id', resumo: 'Baixa um arquivo que o contato enviou (aceita Range); o tipo da resposta é o do próprio arquivo.', respostaTipo: 'application/octet-stream' },
    { metodo: 'GET', caminho: '/api/inbox/mentions', resumo: 'Lista as suas menções não lidas em notas internas.' },
    { metodo: 'POST', caminho: '/api/inbox/mentions/:id/read', resumo: 'Marca uma menção como lida.' },
    { metodo: 'GET', caminho: '/api/inbox/runnable-automations', resumo: 'Lista as automações ligadas que a equipe pode rodar pelo chat; com `conversation_id`, só as que servem ao canal da conversa.' },
    { metodo: 'GET', caminho: '/api/inbox/saved-replies', resumo: 'Lista as respostas salvas (atalho e texto).' },
    { metodo: 'POST', caminho: '/api/inbox/saved-replies', resumo: 'Cria uma resposta salva com atalho único.', corpo: inboxSavedReplySchema, exemplo: { shortcut: 'horario', body: 'Atendemos de segunda a sexta, das 9h às 18h.' } },
    { metodo: 'PUT', caminho: '/api/inbox/saved-replies/:id', resumo: 'Altera atalho e texto de uma resposta salva.', corpo: inboxSavedReplySchema, exemplo: { shortcut: 'horario', body: 'Atendemos de segunda a sábado, das 9h às 18h.' } },
    { metodo: 'DELETE', caminho: '/api/inbox/saved-replies/:id', resumo: 'Exclui uma resposta salva.' },
    { metodo: 'GET', caminho: '/api/inbox/settings', resumo: 'Mostra os ajustes da caixa de entrada: minutos de pausa das automações após resposta humana e o que conta como mensagem nova.' },
    { metodo: 'PUT', caminho: '/api/inbox/settings', resumo: 'Altera os minutos de pausa das automações após resposta humana e o que conta como mensagem nova.', corpo: inboxSettingsSchema, exemplo: { pause_minutes: 30, new_message_behavior: 'any_message' } },
  ],
}
