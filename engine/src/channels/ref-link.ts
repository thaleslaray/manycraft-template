import { PREFILL_MAX, type RefChannel } from '../../../shared/ref-link'

// Link de referência por canal (wa.me, m.me, ig.me): o que cada canal aceita como endereço e como o código chega de volta.
const CHANNELS: readonly string[] = ['whatsapp', 'messenger', 'instagram', 'telegram']
export const refChannelOf = (kind: string): RefChannel | undefined => CHANNELS.includes(kind) ? kind as RefChannel : undefined
/** O canal cujo link só carrega texto pré-preenchido: o código do link volta dentro da mensagem do contato. */
export const carriesCodeInText = (kind: string) => kind === 'whatsapp' || kind === 'telegram'
/** O texto que leva o código: no Telegram o link manda "/start <código>". */
export const refTextOf = (kind: string, text: string) => kind === 'telegram' ? text.replace(/^\/start\s+/i, '') : text
/** Tamanho do texto pré-preenchido, quando o canal tem um. */
export const prefillMax = (channel: RefChannel) => channel === 'whatsapp' ? PREFILL_MAX : 0

export type HandleResult = { ok: true; handle: string } | { ok: false; message: string }
/** Endereço do link: número internacional só com dígitos (wa.me), nome ou ID da Página (m.me) ou usuário (ig.me). */
export function normalizeHandle(channel: RefChannel, raw: string): HandleResult {
  if (channel === 'whatsapp') {
    const digits = raw.replace(/[\s()+-]/g, '')
    return /^[1-9]\d{7,14}$/.test(digits) ? { ok: true, handle: digits }
      : { ok: false, message: 'Informe o número do WhatsApp com código do país e DDD, só dígitos (ex.: 5511999990000).' }
  }
  if (channel === 'telegram') {
    const bot = raw.trim().replace(/^(https?:\/\/)?(t\.me|telegram\.me)\//i, '').replace(/[?#].*$/, '').replace(/^@|\/+$/g, '')
    return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(bot) ? { ok: true, handle: bot } : { ok: false, message: 'Informe o usuário do bot do Telegram (ex.: @minhaloja_bot).' }
  }
  if (channel === 'messenger') {
    const name = raw.replace(/^https?:\/\/(www\.)?(m\.me|facebook\.com)\//i, '').replace(/^\/+|\/+$/g, '')
    return /^[A-Za-z0-9._-]{1,100}$/.test(name) ? { ok: true, handle: name } : { ok: false, message: 'Informe o nome (ou o ID) da Página do Facebook, sem espaços.' }
  }
  const user = raw.trim().replace(/^(https?:\/\/)?(www\.)?(ig\.me\/m|instagram\.com)\//i, '').replace(/[?#].*$/, '').replace(/^@|\/+$/g, '')
  return /^[A-Za-z0-9._]{1,30}$/.test(user) ? { ok: true, handle: user } : { ok: false, message: 'Informe o nome de usuário do Instagram, sem espaços.' }
}
