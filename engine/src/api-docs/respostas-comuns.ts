// Pedaços de formato de resposta usados por mais de uma área do catálogo (campo `resposta` das entradas).
// Só documentação: os handlers não validam a saída com estes schemas. engine/test/api-docs-respostas.test.ts confere contra a resposta real.
import { z } from 'zod'

/** Data e hora em ISO 8601, UTC (ex.: `2026-11-25T14:03:00.000Z`). */
export const dataIso = (descricao = 'Data e hora em ISO 8601 (UTC).') => z.iso.datetime().describe(descricao)

/** Linha da tabela de contatos, como o motor devolve em todas as rotas de contato. */
export const contatoResposta = z.object({
  id: z.string(),
  workspace_id: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable().describe('Só dígitos, com o código do país (ex.: `5511912345678`).'),
  status: z.enum(['subscribed', 'unsubscribed', 'visitor', 'deleted']).describe('`subscribed` inscrito, `unsubscribed` descadastrado, `visitor` visitante (ainda não se inscreveu), `deleted` excluído (só aparece quando pedido).'),
  optin_source: z.string().nullable().describe('Por onde entrou: `trigger:<id do gatilho>`, `manual`, `import`, `api`...'),
  profile_pic_url: z.string().nullable(),
  gender: z.string().nullable(),
  locale: z.string().nullable(),
  timezone: z.string().nullable(),
  automation_paused_until: dataIso('Automações pausadas para o contato até esta data (ISO 8601, UTC); `null` = não pausadas.').nullable(),
  last_input_text: z.string().nullable().describe('Último texto que o contato mandou.'),
  subscribed_at: dataIso('Quando o contato entrou (ISO 8601, UTC). A lista ordena por aqui, do mais novo para o mais antigo.'),
  last_interaction_at: dataIso('Última interação do contato (ISO 8601, UTC).').nullable(),
  created_at: dataIso(),
  updated_at: dataIso(),
})

/** Contato da lista paginada: a linha mais as tags e os valores dos campos personalizados. */
export const contatoDaListaResposta = contatoResposta.extend({
  tags: z.array(z.object({ id: z.string(), name: z.string() })),
  fields: z.record(z.string(), z.unknown()).describe('Valor de cada campo personalizado preenchido, pela chave do id do campo (`GET /api/fields`).'),
  conversation_deleted: z.boolean().describe('`true` quando todas as conexões do contato recusam envio por bloqueio (ele apagou a conversa ou bloqueou a conta).'),
})

/** Página de contatos (GET /api/contacts e POST /api/contacts/query). */
export const paginaDeContatosResposta = z.object({
  rows: z.array(contatoDaListaResposta).describe('Até 40 contatos por página.'),
  total: z.number().int().describe('Quantos contatos atendem ao filtro, somando todas as páginas.'),
  next_cursor: z.string().nullable().describe('Mande em `cursor` para pegar a próxima página; `null` na última.'),
})

/** Tag como vem na ficha do contato; a lista de tags acrescenta `archived` e `folder_id`. */
export const tagResposta = z.object({
  id: z.string(),
  workspace_id: z.string(),
  name: z.string(),
  contact_count: z.number().int().describe('Contatos com a tag (excluídos não contam).'),
  created_at: dataIso(),
})

/** Conversa da caixa de entrada (lista, etiqueta e demais ações que devolvem a conversa). */
export const conversaResposta = z.object({
  id: z.string(),
  contact: z.object({
    id: z.string(),
    name: z.string().describe('Nome e sobrenome; "Contato sem nome" quando não há.'),
    avatar_initials: z.string(),
    avatar_url: z.string().optional(),
    email: z.string().optional().describe('Só em conexão de e-mail: o endereço do contato.'),
  }),
  channel_type: z.string().describe('Canal da conexão (o mesmo `kind` de `GET /api/connections`).'),
  connection_id: z.string(),
  connection_name: z.string().nullable(),
  connection_profile: z.object({}).describe('O que a conexão suporta (blocos, janela, modelos...): mesmo formato de `profile` em `GET /api/connections/{id}`.'),
  opted_in: z.boolean().describe('O contato autorizou mensagens nesta conexão.'),
  last_message: z.object({
    text: z.string(),
    at: dataIso(),
    direction: z.enum(['in', 'out']).describe('`in` do contato, `out` da conta.'),
  }).describe('Última mensagem (notas internas e eventos não contam).'),
  unread_count: z.number().int(),
  status: z.enum(['open', 'closed']),
  assignee_id: z.string().nullable().describe('Id do membro atribuído (o `id` de `GET /api/team`); `null` = sem atribuição.'),
  reply_policy: z.object({
    can_reply: z.boolean().describe('Dá para responder agora com texto livre.'),
    expires_at: dataIso('Quando a janela de resposta fecha (ISO 8601, UTC); `null` = canal sem janela.').nullable(),
    mode: z.literal('human_agent').optional().describe('Presente quando só vale a janela estendida de atendimento humano.'),
    human_expires_at: dataIso('Fim da janela estendida de atendimento humano (ISO 8601, UTC).').optional(),
    template_connection_id: z.string().optional().describe('Conexão por onde dá para mandar modelo aprovado, quando a janela fechou.'),
  }),
  window_expires_at: dataIso('Fim da janela padrão de 24 h (ISO 8601, UTC).').nullable(),
  automation_paused_until: dataIso('Automações pausadas para o contato até esta data (ISO 8601, UTC).').nullable(),
  reminder_at: dataIso('Lembrete marcado na conversa (ISO 8601, UTC).').nullable(),
  reminder_note: z.string().nullable(),
  labels: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })),
})
