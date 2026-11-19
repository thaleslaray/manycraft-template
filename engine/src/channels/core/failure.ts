import type { IntegrationEnv } from '../../integrations'
import type { SendResult } from '../types'
import { moveConnection } from './connection-state'

/** Provider refusals the person can fix. The generic "o canal não confirmou" text hides them, so each gets its own explanation. */
const notices: Record<string, string> = {
  // Meta: token expired, revoked or password changed.
  '190': 'A Meta recusou o token de acesso desta conexão (expirou ou foi revogado). Reconecte o canal com um token novo.',
  // Meta Conversation Routing: another app on the same account may own the thread (the Meta error does not say who owns it now).
  '131070': 'A Meta recusou o envio porque outro app (outro parceiro do mesmo número) pode estar controlando esta conversa. Só quem controla a conversa pode responder. '
    + 'Para mudar isso, abra o Gerenciador de Negócios, vá em Contas do WhatsApp, escolha o número e abra Conversation routing; '
    + 'lá você define qual app recebe cada tipo de conversa. Também é possível pedir o controle ao app que está com ela.',
  '131049': 'A Meta não entregou esta mensagem de marketing para manter a qualidade das conversas do contato. A Meta limitou mensagens de marketing para ele; tente de novo depois de 24 horas.',
  '131050': 'O contato cancelou o recebimento de mensagens de marketing deste número. Não envie marketing a ele de novo; mensagens que ele pedir continuam permitidas.',
  '131026': 'A Meta não conseguiu entregar a mensagem: o número pode não ter WhatsApp, não ter aceitado os novos termos ou usar uma versão antiga do aplicativo. Confira o número do contato.',
  '131047': 'A janela de atendimento de 24 horas terminou. Para falar com este contato agora, envie um modelo aprovado.',
  '131063': 'A Meta recusou o modelo de marketing porque o envio de marketing pela API de nuvem está desativado nesta conta e ela ainda não usa a API de Mensagens de Marketing. '
    + 'Aceite os termos dessa API (Gerenciador do WhatsApp, Visão geral, Alertas, Aceitar termos) e use Verificar de novo em Canais, ou reative o marketing na API de nuvem.',
  '131055': 'A API de Mensagens de Marketing só aceita modelos de marketing e o modelo enviado não é dessa categoria. Atualize os modelos em Modelos e envie de novo.',
  '134100': 'A API de Mensagens de Marketing só aceita modelos de marketing e o modelo enviado não é dessa categoria (a Meta pode ter reclassificado o modelo). Atualize os modelos em Modelos e envie de novo.',
  '134101': 'A Meta ainda está sincronizando este modelo de marketing, o que leva até 10 minutos depois de criar o modelo ou de usá-lo após 7 dias parado. Espere 10 minutos e envie de novo.',
  '134102': 'A conta não está habilitada para a API de Mensagens de Marketing, ou a Meta não conseguiu sincronizar o modelo. Confira em Canais, use Verificar de novo e, se continuar, aceite os termos no Gerenciador do WhatsApp (Visão geral, Alertas, Aceitar termos) ou fale com o suporte da Meta.',
  '131061': 'A Meta recusou o modelo porque ele tem preço máximo e a API de nuvem não aceita esse tipo de modelo. Envie-o pela API de Mensagens de Marketing, depois de aceitar os termos dela em Canais.',
  '131062': 'A Meta não aceita este envio para um contato identificado só por identificador de usuário (BSUID): o modelo tem preço máximo ou é de autenticação. Envie ao contato pelo telefone ou use outro modelo.',
  '131064': 'A Meta limitou os envios deste número porque os modelos usados violaram a classificação de categoria. Revise as categorias dos modelos; o limite sai sozinho ao fim do período.',
  // Unofficial WhatsApp provider error_key (send 500): WhatsApp temporarily blocks the number from starting new conversations (error 463).
  WHATSAPP_REACHOUT_TIMELOCK: 'O WhatsApp restringiu temporariamente este número para iniciar novas conversas (volume ou qualidade dos envios). Enquanto durar, só saem respostas a quem escreveu nas últimas 24 horas: sequências e transmissões esperam, e as outras automações que tentarem falar com quem não escreveu param com falha (não são reenviadas). Quando a restrição acabar, use Atualizar conexão em Canais.',
  invalid_recipient: 'O endereço do destinatário não é válido para este canal. Confira o número do contato.',
  '131065': 'A Meta não enviou o modelo porque o país do contato não aceita preço máximo. Envie a este contato sem preço máximo.',
}

/** Where a failure code takes a broadcast: stop everyone (`pause`), drop only this contact (`skip`), or count it and keep going (`continue`). */
export type FailureAction = 'pause' | 'skip' | 'continue'
const pauses = new Set(['130429', '131056', '131048', '368', '131031', '131042', '132015', '132016', '133010', '80007', '190', 'token_refused', '131063', '131064', '131055', '134100', '134101', '134102', '131061', 'WHATSAPP_REACHOUT_TIMELOCK', 'channel_not_configured', 'connection_unavailable',
  // connection_restricted: the number may not start conversations for now. Failing the contact would burn it for good (nothing resends
  // a closed broadcast), so the broadcast waits with the contact still queued and goes on once the restriction ends.
  'connection_restricted'])
// 131049 is Meta's per-contact marketing limit: it says nothing about the account, so the broadcast goes on without that contact.
const skips = new Set(['131050', '131049', '131026', '131065', '131070', '131062'])
export const failureAction = (code: string): FailureAction => pauses.has(code) ? 'pause' : skips.has(code) ? 'skip' : 'continue'

/** Contacts Meta refused to reach with marketing (opted out, or the per-contact limit): the recipient is "skipped", not a failure the operator must fix.
 * The other `skip` codes (131026, 131065, 131070) are real delivery failures kept as `failed`, with the code. */
const marketingRefusals = new Set(['131050', '131049'])

/** What a refused send becomes on a broadcast recipient. `outside_window` carries Meta's 131047 only on WhatsApp; other channels keep their own reason. */
export function recipientFailure(result: Extract<SendResult, { ok: false }>, channel: string): { status: 'skipped' | 'failed' | 'uncertain'; reason: string } {
  if (result.reason === 'uncertain') return { status: 'uncertain', reason: result.reason }
  if (result.reason === 'rejected') return { status: marketingRefusals.has(result.code) ? 'skipped' : 'failed', reason: result.code }
  return { status: 'failed', reason: result.reason === 'outside_window' && channel === 'whatsapp' ? '131047' : result.reason }
}

export function failureNotice(result: SendResult): string | undefined {
  if (result.ok || result.reason !== 'rejected') return undefined
  // `token_refused`: HTTP 401 on a send of a provider whose credential is pasted. The adapter knows the provider and writes the fix in `detail`.
  if (result.code === 'token_refused') return result.detail
  if (notices[result.code]) return notices[result.code]
  // Sem explicação própria para o código: diz o que a Meta respondeu (já sem token), para o motivo não ficar escondido.
  const m = result.meta
  if (!m) return undefined
  return `A Meta recusou o envio (código ${m.code ?? result.code}${m.subcode !== undefined ? `, subcódigo ${m.subcode}` : ''})${m.message ? `: ${m.message}` : ''}${m.traceId ? ` [rastreio ${m.traceId}]` : ''}.`
}

export type DeliveryError = { code: string; title?: string; detail?: string }
/** The reason the operator reads for a failed receipt: our explanation when the code is known, otherwise the code and what Meta said. */
export function receiptFailureNotice(errors: DeliveryError[]): string | undefined {
  const first = errors[0]
  if (!first) return undefined
  return notices[first.code] ?? `A Meta não entregou a mensagem (código ${first.code}${first.title ? `: ${first.title}` : ''}${first.detail ? `. ${first.detail}` : ''}).`
}

/** Codes that mean the credential itself was refused (Meta 190; `token_refused`, the HTTP 401 on a send of the providers with a pasted token). Rate limits, 5xx and network
 * errors never get here: they are `rate_limited` or `uncertain`, not `rejected`. */
const tokenRefusals = new Set(['190', 'token_refused'])

/** A refused credential will refuse every next send too: say so on the connection instead of leaving it "connected". */
export async function noteConnectionFailure(env: Pick<IntegrationEnv, 'DB'>, workspaceId: string, channelId: string, result: SendResult): Promise<void> {
  if (result.ok || result.reason !== 'rejected') return
  // The Marketing Messages API says the account is not eligible: stop routing marketing there. `checkedAt` goes to zero so the next send asks the provider again instead of trusting the stored answer for a day.
  if (result.code === '134102') {
    await env.DB.prepare("UPDATE channels SET settings=json_set(settings,'$.marketingMessages.enabled',json('false'),'$.marketingMessages.checkedAt',0) WHERE workspace_id=? AND id=? AND json_type(settings,'$.marketingMessages') IS NOT NULL").bind(workspaceId, channelId).run()
    return
  }
  if (result.code === 'WHATSAPP_REACHOUT_TIMELOCK') {
    await moveConnection(env.DB, { id: channelId, workspaceId, event: 'send_refused', to: 'restricted', detail: notices.WHATSAPP_REACHOUT_TIMELOCK })
    return
  }
  if (!tokenRefusals.has(result.code)) return
  // A connection waiting for its first webhook after new credentials (`pending`) is refused the same way.
  await moveConnection(env.DB, { id: channelId, workspaceId, event: 'send_refused', to: 'error', detail: result.code === 'token_refused' ? result.detail : notices[result.code] })
}
