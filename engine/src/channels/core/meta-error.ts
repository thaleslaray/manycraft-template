import type { MetaErrorInfo } from '../types'

/** Tira da mensagem da Meta o que parece token (parâmetro access_token e sequências longas) antes de gravar, logar ou responder. */
export const scrubMetaText = (text: string) => text.replace(/(access_token=)[^\s&"')]+/gi, '$1[oculto]').replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[oculto]').slice(0, 400)

/** Corpo `error` da Graph -> código, subcódigo, mensagem (já sem token), tipo e rastreio. `undefined` quando não há `error`. */
export function parseMetaError(body: unknown): MetaErrorInfo | undefined {
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  if (typeof error !== 'object' || error === null) return undefined
  const e = error as Record<string, unknown>
  const text = (value: unknown, max = 400) => typeof value === 'string' && value ? scrubMetaText(value).slice(0, max) : undefined
  const message = text(e.error_user_msg ?? e.message)
  return { ...(typeof e.code === 'number' ? { code: e.code } : {}), ...(typeof e.error_subcode === 'number' ? { subcode: e.error_subcode } : {}),
    ...(message ? { message } : {}), ...(text(e.type, 80) ? { type: text(e.type, 80) } : {}), ...(text(e.fbtrace_id, 80) ? { traceId: text(e.fbtrace_id, 80) } : {}) }
}

/** Frases por código da Graph para pedidos de conta (perfil, nome de usuário, revisão): o que a pessoa pode corrigir. */
const accountNotices: Record<number, string> = {
  190: 'A Meta recusou o token de acesso desta conexão (expirou ou foi revogado). Use Trocar credencial com um token novo.',
  10: 'O token não tem a permissão que este pedido exige. Gere um token com as permissões do app e use Trocar credencial.',
  200: 'O token não tem a permissão que este pedido exige. Gere um token com as permissões do app e use Trocar credencial.',
  100: 'A Meta recusou um campo do pedido (valor inválido ou não aceito para esta conta). Confira os campos e tente de novo.',
  131009: 'A Meta recusou um parâmetro do pedido (valor fora do permitido). Confira os campos e tente de novo.',
  4: 'A Meta limitou os pedidos deste app por um tempo. Espere alguns minutos e tente de novo.',
  80007: 'A Meta limitou os pedidos desta conta por um tempo. Espere alguns minutos e tente de novo.',
}

/** Status HTTP coerente com a recusa: token recusado 409; limite 429; recusa de regra 422. Falha de rede ou 5xx fica com quem chama (502). */
export const metaRefusalStatus = (meta: MetaErrorInfo): 409 | 422 | 429 =>
  meta.code === 190 ? 409 : meta.code === 4 || meta.code === 80007 ? 429 : 422

/** Frase pt-BR de uma recusa da Graph: a explicação do código quando há, senão "A Meta recusou <ação>", sempre com código e subcódigo.
 * `echo: false` não repete o texto da Meta (pedidos cujo erro pode trazer dados da conta). */
export function metaRefusalNotice(action: string, meta: MetaErrorInfo, opts: { echo?: boolean } = {}): string {
  const codes = meta.code === undefined ? '' : ` (código ${meta.code}${meta.subcode !== undefined ? `, subcódigo ${meta.subcode}` : ''})`
  const known = meta.code !== undefined ? accountNotices[meta.code] : undefined
  const said = opts.echo !== false && meta.message ? ` A Meta disse: ${meta.message}` : ''
  return `${(known ?? `A Meta recusou ${action}.`).replace(/\.$/, '')}${codes}.${said}`
}

/** Mensagem da conexão sem credencial guardada (marcada como ligada, mas sem token cifrado). */
export const NO_CREDENTIALS = 'Esta conexão está sem credencial salva. Cole o token de novo em Trocar credencial.'

/** Recusa do provedor que já traz a frase e o status HTTP certos (a rota repassa os dois em vez do 422 genérico). */
export class ProviderRefusal extends Error {
  constructor(readonly status: 409 | 422 | 429 | 502, message: string) { super(message) }
}
