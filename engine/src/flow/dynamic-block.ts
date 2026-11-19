import { z } from 'zod'
import { ExternalRequestError, isInternalHost } from './external-url'
import { readLimited, REQUEST_TIMEOUT_MS, type RequestEnv } from './external-request'

/**
 * Bloco dinâmico: o servidor do cliente recebe os dados completos do contato e devolve o conteúdo no formato v2
 * (mensagens, ações e respostas rápidas). Limites do formato: 10 mensagens, 11 respostas rápidas, 5 ações por resposta.
 */
export const dynamicConfigSchema = z.object({ url: z.url({ protocol: /^https$/ }), fallback_text: z.string().trim().max(1000).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH']).default('POST'),
  headers: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9-]{1,100}$/), value: z.string().max(2000) })).max(10).default([]),
  /** Corpo próprio (JSON com variáveis); sem ele vai o contato completo. */
  body: z.string().max(10000).optional() })

const button = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url'), caption: z.string().min(1).max(64), url: z.url({ protocol: /^https?$/ }), webview_size: z.enum(['full', 'medium', 'compact']).optional() }),
  z.object({ type: z.literal('dynamic_block_callback'), caption: z.string().min(1).max(64), url: z.url({ protocol: /^https$/ }) }),
])
const message = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(2000), buttons: z.array(button).max(3).optional() }),
  z.object({ type: z.literal('image'), url: z.url({ protocol: /^https$/ }), buttons: z.array(button).max(3).optional() }),
])
const action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add_tag'), tag_name: z.string().min(1).max(190) }),
  z.object({ action: z.literal('remove_tag'), tag_name: z.string().min(1).max(190) }),
  z.object({ action: z.literal('set_field_value'), field_name: z.string().min(1).max(190), value: z.unknown() }),
  z.object({ action: z.literal('unset_field_value'), field_name: z.string().min(1).max(190) }),
])
/** A próxima mensagem de texto do contato vai a este servidor (payload com {{last_input_text}} e {{user_id}}); prazo padrão e máximo de 1 dia. */
export const externalCallbackSchema = z.object({ url: z.url({ protocol: /^https$/ }), method: z.enum(['post', 'put', 'patch', 'get', 'delete']).default('post'),
  headers: z.record(z.string().max(100), z.string().max(1000)).default({}), payload: z.unknown().optional(),
  timeout: z.number().int().positive().max(86_400).default(86_400) })
export const dynamicResponseSchema = z.object({ version: z.literal('v2'), content: z.object({
  messages: z.array(message).max(10, 'Até 10 mensagens por resposta.').default([]),
  actions: z.array(action).max(5, 'Até 5 ações por resposta.').default([]),
  quick_replies: z.array(z.object({ type: z.literal('dynamic_block_callback'), caption: z.string().min(1).max(20), url: z.url({ protocol: /^https$/ }) }))
    .max(11, 'Até 11 respostas rápidas por resposta.').default([]),
  external_message_callback: externalCallbackSchema.optional(),
}).passthrough() }).passthrough()
export type DynamicResponse = z.infer<typeof dynamicResponseSchema>

/** Dados completos do contato (variável Full Contact Data): campos do sistema, campos personalizados por nome e tags. */
export async function fullContactData(db: D1Database, workspace: string, contactId: string) {
  const [contact, fields, tags] = await Promise.all([
    db.prepare(`SELECT id,first_name,last_name,gender,locale,timezone,email,phone,status,subscribed_at,last_interaction_at,last_input_text,profile_pic_url
      FROM contacts WHERE workspace_id=? AND id=?`).bind(workspace, contactId).first<Record<string, string | number | null>>(),
    db.prepare(`SELECT f.name,v.value FROM contact_field_values v JOIN custom_fields f ON f.workspace_id=v.workspace_id AND f.id=v.field_id WHERE v.workspace_id=? AND v.contact_id=?`)
      .bind(workspace, contactId).all<{ name: string; value: string }>(),
    db.prepare('SELECT t.name FROM contact_tags ct JOIN tags t ON t.workspace_id=ct.workspace_id AND t.id=ct.tag_id WHERE ct.workspace_id=? AND ct.contact_id=? ORDER BY t.name')
      .bind(workspace, contactId).all<{ name: string }>(),
  ])
  if (!contact) return null
  const iso = (v: string | number | null) => typeof v === 'number' ? new Date(v).toISOString() : v
  return { id: contact.id, first_name: contact.first_name, last_name: contact.last_name,
    name: [contact.first_name, contact.last_name].filter(Boolean).join(' '), gender: contact.gender, locale: contact.locale, timezone: contact.timezone,
    email: contact.email, phone: contact.phone, status: contact.status, subscribed: iso(contact.subscribed_at), last_interaction: iso(contact.last_interaction_at),
    last_input_text: contact.last_input_text, profile_pic: contact.profile_pic_url,
    custom_fields: Object.fromEntries(fields.results.map(f => [f.name, JSON.parse(f.value) as unknown])), tags: tags.results.map(t => t.name) }
}

/** Chama o servidor (POST JSON, 10 s, sem redirecionamento, sem endereço interno) e valida a resposta v2. Erros voltam como ExternalRequestError. */
export async function callDynamic(_env: RequestEnv, url: string, body: unknown, fetcher: typeof fetch = fetch, options: { method?: string; headers?: Record<string, string>; rawBody?: string } = {}): Promise<DynamicResponse> {
  let target: URL
  try { target = new URL(url) } catch { throw new ExternalRequestError('invalid_url', 'Endereço do bloco dinâmico inválido.') }
  if (target.protocol !== 'https:' || isInternalHost(target.hostname)) throw new ExternalRequestError('blocked_address', 'Use um endereço https público.')
  // Timeout e queda de rede viram ExternalRequestError tanto na conexão quanto na leitura do corpo (o prazo de 10 s vale para os dois).
  const network = (error: unknown) => {
    if (error instanceof ExternalRequestError) return error
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return new ExternalRequestError(timedOut ? 'timeout' : 'network', timedOut ? 'O servidor passou de 10 segundos.' : 'Não foi possível conectar ao servidor.')
  }
  let response: Response
  try {
    const method = options.method ?? 'POST'
    response = await fetcher(target, { method, headers: { 'content-type': 'application/json', ...options.headers }, ...(method === 'GET' ? {} : { body: options.rawBody ?? JSON.stringify(body) }), redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) { throw network(error) }
  if (response.status !== 200) { await response.body?.cancel(); throw new ExternalRequestError('http_status', `O servidor respondeu ${response.status}.`) }
  // Passou de 1 MB: a leitura para e lança ExternalRequestError('too_large'), sem guardar o corpo inteiro.
  let text: string
  try { text = await readLimited(response) } catch (error) { throw network(error) }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new ExternalRequestError('invalid_json', 'A resposta não é JSON válido.') }
  const result = dynamicResponseSchema.safeParse(parsed)
  if (!result.success) throw new ExternalRequestError('invalid_value', `Resposta fora do formato v2: ${result.error.issues[0]?.message ?? 'inválida'}`)
  return result.data
}

/** Resposta v2 -> blocos de mensagem do editor (texto, imagem, botões de link e de retorno ao servidor, respostas rápidas). */
export function dynamicBlocks(response: DynamicResponse) {
  const blocks: Record<string, unknown>[] = []
  let n = 0
  const buttonOf = (b: z.infer<typeof button>) => ({ kind: 'button', id: `dyn-${n++}`, label: b.caption,
    action: b.type === 'url' ? { type: 'url', url: b.url, ...(b.webview_size ? { webview_size: b.webview_size } : {}) } : { type: 'dynamic', url: b.url } })
  for (const m of response.content.messages) {
    blocks.push(m.type === 'text' ? { kind: 'text', text: m.text } : { kind: 'media', media: 'image', url: m.url })
    for (const b of m.buttons ?? []) blocks.push(buttonOf(b))
  }
  for (const q of response.content.quick_replies) blocks.push({ kind: 'button', id: `dyn-${n++}`, label: q.caption, action: { type: 'dynamic', url: q.url } })
  return blocks
}

/** Ações por nome (como no original) -> ações do motor por id. Tag ou campo inexistente é ignorado. */
export async function dynamicActions(db: D1Database, workspace: string, response: DynamicResponse) {
  const out: Record<string, unknown>[] = []
  for (const a of response.content.actions) {
    if (a.action === 'add_tag' || a.action === 'remove_tag') {
      const tag = await db.prepare('SELECT id FROM tags WHERE workspace_id=? AND name=? AND archived=0').bind(workspace, a.tag_name).first<{ id: string }>()
      if (tag) out.push({ type: a.action, tag_id: tag.id })
    } else {
      const field = await db.prepare("SELECT id FROM custom_fields WHERE workspace_id=? AND name=? AND scope='contact'").bind(workspace, a.field_name).first<{ id: string }>()
      if (field) out.push(a.action === 'set_field_value' ? { type: 'set_custom_field_value', field_id: field.id, value: a.value } : { type: 'unset_custom_field_value', field_id: field.id })
    }
  }
  return out
}
