import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from '../../env'
import { connectionRuntime } from './runtime'
import { deliverHuman } from './delivery'
import { claimNumber } from './whatsapp-numbers'
import { stableId } from '../../flow/types'
import { prepareTemplateMessage } from '../../inbox/template-message'
import { ensureConversation, getConversation } from '../../inbox/service'
import { newIdentityConsent } from './consent'

/** A person who never wrote to the number has no BSUID yet: the conversation starts from the phone, with an approved template.
 * The only door the Cloud API leaves open for a first contact. */
export const startSchema = z.object({
  connection_id: z.string().min(1).max(128),
  phone: z.string().trim().min(5).max(40),
  name: z.string().trim().max(120).optional(),
  // The operator confirms the person agreed to hear from this business: a template to someone without consent is spam under Meta's policy.
  consent: z.literal(true, { message: 'Confirme que o contato aceitou receber mensagens.' }),
  // Which one is allowed depends on the connection's ficha: a template (approved) or free text (opt-in channels).
  template: z.object({ id: z.string().min(1).max(256), params: z.record(z.string().max(128), z.string().trim().min(1).max(1024)) }).strict().optional(),
  text: z.string().trim().min(1).max(4096).optional(),
}).strict().refine(value => (value.template === undefined) !== (value.text === undefined), { message: 'Envie um modelo ou um texto, não os dois.' })

/** "+55 (11) 99999-0001" -> "5511999990001" (country code first, no zero, 8 to 15 digits). */
export function phoneDigits(value: string): string {
  const digits = value.replace(/[\s().-]/g, '').replace(/^\+/, '')
  if (!/^[1-9]\d{7,14}$/.test(digits)) throw new HTTPException(400, { message: 'Informe o telefone com código do país e DDD, por exemplo +55 11 99999-0001.' })
  return digits
}

export async function startConversation(env: Env, workspaceId: string, input: z.infer<typeof startSchema>) {
  const digits = phoneDigits(input.phone)
  const rt = await connectionRuntime(env, workspaceId, input.connection_id, { requireConnected: true }).catch(() => undefined)
  if (!rt) throw new HTTPException(404, { message: 'Conexão não encontrada ou desconectada.' })
  const { initiator, identity } = rt.connection.profile
  if (!rt.provider || initiator === 'user' || initiator === 'business_with_optin' && identity.key !== 'phone_e164')
    throw new HTTPException(409, { message: 'Esta conexão não permite iniciar uma conversa pelo painel. A pessoa precisa escrever primeiro.' })
  if (initiator === 'business_with_template' && !input.template) throw new HTTPException(400, { message: 'Esta conexão só inicia conversa com um modelo aprovado.' })
  if (initiator === 'business_with_optin' && !input.text) throw new HTTPException(400, { message: 'Escreva a mensagem que inicia a conversa.' })
  if (input.template) await prepareTemplateMessage(env, workspaceId, rt.connection.id, input.template)   // refuses (404/400) before anything is created
  // Providers that can tell whether the number has an account: ask before creating anything. Only a definite "no" blocks.
  if (rt.provider.checkRecipient && await rt.provider.checkRecipient({ connection: rt.connection, credentials: await rt.credentials(), fetch: rt.fetch }, digits) === 'no')
    throw new HTTPException(409, { message: 'Este número não tem WhatsApp.' })
  // How this provider names a person reached by phone (its inbound uses the same form, so a reply lands in this conversation).
  const outboundId = identity.address === 'jid' ? `${digits}@s.whatsapp.net` : digits
  const e164 = `+${digits}`
  const findChannel = () => env.DB.prepare(`SELECT contact_id,external_user_id,opted_in FROM contact_channels WHERE workspace_id=? AND channel_id=? AND (external_user_id=? OR external_user_id=? OR phone_e164=?)`)
    .bind(workspaceId, rt.connection.id, outboundId, digits, e164).first<{ contact_id: string; external_user_id: string; opted_in: number }>()
  type Found = { contact_id: string; external_user_id: string; opted_in: number }
  let cc: Found | null = await findChannel()
  if (!cc) {
    const contactId = await claimNumber(env.DB, workspaceId, e164, `wa-out-${await stableId(workspaceId, rt.connection.id, digits)}`, rt.connection.id, input.name || null)
    // The person may already be known on this connection under a BSUID (they wrote before, or another contact row carries the number).
    cc = await env.DB.prepare('SELECT contact_id,external_user_id,opted_in FROM contact_channels WHERE workspace_id=? AND channel_id=? AND contact_id=?')
      .bind(workspaceId, rt.connection.id, contactId).first<Found>()
    if (!cc) {
      // The official API keeps a legacy phone id until the person's BSUID shows up; the others store the provider's own id with its address kind.
      // A equipe confirmou o consentimento: a identidade nasce inscrita e com a hora da mudança (consent.ts), como um START.
      const consent = newIdentityConsent(true)
      if (initiator === 'business_with_template') await env.DB.prepare(`INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,opted_in,consent_changed_at)
        VALUES (?,?,?,?,?,'wa_phone_legacy',?,?) ON CONFLICT(channel_id,external_user_id) DO NOTHING`)
        .bind(crypto.randomUUID(), workspaceId, contactId, rt.connection.id, digits, consent.opted_in, consent.consent_changed_at).run()
      else await env.DB.prepare(`INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,address_kind,phone_e164,opted_in,consent_changed_at)
        VALUES (?,?,?,?,?,'provider_id','wa_pn',?,?,?) ON CONFLICT(channel_id,external_user_id) DO NOTHING`)
        .bind(crypto.randomUUID(), workspaceId, contactId, rt.connection.id, outboundId, e164, consent.opted_in, consent.consent_changed_at).run()
      cc = await findChannel()
    }
  }
  if (!cc) throw new HTTPException(409, { message: 'Este telefone já está ligado a outro contato.' })
  if (!cc.opted_in) throw new HTTPException(409, { message: 'Este contato pediu para não receber mensagens.' })
  const conversationId = await ensureConversation(env, workspaceId, cc.contact_id, rt.connection.id)
  const sent = await deliverHuman(env, { connection: rt.connection, provider: rt.provider, credentials: rt.credentials }, {
    workspaceId, conversationId, contactId: cc.contact_id, externalUserId: cc.external_user_id, text: input.text ?? '', ...(input.template ? { template: input.template } : {}) })
  if (!sent.ok && sent.reason === 'rate_limited') throw new HTTPException(429, { message: 'Aguarde um instante antes de enviar novamente.' })
  if (!sent.ok) throw new HTTPException(409, { message: 'Esta conexão não pode enviar agora. Confira se a conexão está ativa e, no WhatsApp oficial, se o modelo está aprovado.' })
  return { conversation: await getConversation(env, workspaceId, conversationId), message: sent.message }
}
