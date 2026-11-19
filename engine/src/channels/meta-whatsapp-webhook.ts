import { z } from 'zod'
import { metaRefusalNotice, parseMetaError } from './core/meta-error'

/** Webhook do WhatsApp oficial apontado só para o número: endereço alternativo por número de telefone
 * (developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override, conferido em 18/11/2026, página de 28/09/2026).
 * Nunca toca a assinatura do app (/{app-id}/subscriptions): ela vale para todos os números do app, que pode ser dividido com outro sistema.
 * O endereço alternativo só cobre os campos de mensagem (messages, message_echoes, calls, messaging_handovers, standby...): avisos de conta e de
 * modelos (account_update, account_alerts, message_template_status_update...) seguem indo para a URL do app. */
type Call = { base: string; token: string; fetch: typeof fetch }

/** "Maximum 200 characters" (override.md, tabela dos parâmetros). */
export const OVERRIDE_URL_MAX = 200

/** Passos do webhook manual do WhatsApp (o painel e o registerWebhook leem daqui). */
export const WHATSAPP_WEBHOOK_STEPS = ['Abra o app no painel de desenvolvedores da Meta e vá em Webhooks.', 'Cole a URL de retorno e o token de verificação acima.',
  'Assine os campos de mensagens e confirme.', 'Se outros parceiros dividem este número (Roteamento de conversas, o Conversation routing da Meta), assine também o campo messaging_handovers.', 'Para ver qualidade, limites, alertas, descadastros e o status dos modelos sem sincronizar, assine também user_preferences, phone_number_quality_update, business_capability_update, account_alerts, account_update, account_review_update, message_template_status_update, message_template_quality_update e template_category_update.']

const success = z.object({ success: z.literal(true) }).passthrough()

/** POST /{phone-number-id} com webhook_configuration { override_callback_uri, verify_token }. A Meta confere o endereço com o token
 * (pedido de verificação com hub.challenge) antes de aceitar. Recusa vira frase pt-BR pelo tradutor de erros da Meta. */
export async function setNumberOverride(call: Call, phoneNumberId: string, url: string, verifyToken: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (url.length > OVERRIDE_URL_MAX) return { ok: false, reason: `o endereço do motor tem mais de ${OVERRIDE_URL_MAX} caracteres, o máximo que a Meta aceita para o webhook do número.` }
  try {
    const response = await call.fetch(`${call.base}/${phoneNumberId}`, { method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${call.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook_configuration: { override_callback_uri: url, verify_token: verifyToken } }) })
    const body = await response.json().catch(() => null)
    if (response.ok && success.safeParse(body).success) return { ok: true }
    const meta = parseMetaError(body)
    return { ok: false, reason: meta ? metaRefusalNotice('configurar o webhook no número', meta) : 'a Meta não confirmou o webhook no número.' }
  } catch { return { ok: false, reason: 'não foi possível falar com a Meta para configurar o webhook no número agora.' } }
}

const configured = z.object({ webhook_configuration: z.object({ phone_number: z.string().optional() }).passthrough().optional() }).passthrough()
/** Tira o endereço alternativo do número só quando é o deste motor (GET ?fields=webhook_configuration, campo phone_number):
 * o de outro sistema fica. Limpar é o mesmo POST com override_callback_uri vazio. Nunca lança. */
export async function clearNumberOverride(call: Call, phoneNumberId: string, url: string): Promise<'cleared' | 'not_ours' | 'unknown'> {
  const headers = { Authorization: `Bearer ${call.token}` }
  try {
    const response = await call.fetch(`${call.base}/${phoneNumberId}?fields=webhook_configuration`, { headers, signal: AbortSignal.timeout(10_000) })
    const parsed = configured.safeParse(await response.json().catch(() => null))
    if (!response.ok || !parsed.success) return 'unknown'
    if (parsed.data.webhook_configuration?.phone_number !== url) return 'not_ours'
    const cleared = await call.fetch(`${call.base}/${phoneNumberId}`, { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ webhook_configuration: { override_callback_uri: '' } }) })
    return cleared.ok && success.safeParse(await cleared.json().catch(() => null)).success ? 'cleared' : 'unknown'
  } catch { return 'unknown' }
}
