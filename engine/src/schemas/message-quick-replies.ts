/** Respostas rápidas e digitação: regras compartilhadas pelo editor (navegador) e pelo motor.
 * Nada aqui pergunta o nome do canal: os limites vêm da ficha efetiva da conexão. */
export const QUICK_REPLY_MAX = 11
export const QUICK_REPLY_TITLE_MAX = 20
export const QUICK_REPLY_ATTEMPTS_MAX = 5
export const QUICK_REPLY_WINDOW_MS = 24 * 3600_000
/** Pular é uma resposta rápida como as outras, só com rótulo fixo. */
export const SKIP_LABEL = 'Pular'

export type QuickReplyBlock = { kind: 'quick_reply'; id: string; label: string; skip?: boolean }
export type QuickReplyProfile = {
  quickReplies?: { max: number; titleMax: number } | null
  buttons: { types: string[]; maxPerMessage: number; titleMax: number; payloadMaxBytes: number }
}
export type QuickReplyLimits = { max: number; titleMax: number; native: boolean }
type Duration = { value: number; unit: 'seconds' | 'minutes' | 'hours' | 'days' }
const unitMs = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 }

export const isQuickReply = (b: unknown): b is QuickReplyBlock =>
  typeof b === 'object' && b !== null && 'kind' in b && b.kind === 'quick_reply'
export const durationMs = (d: Duration) => d.value * unitMs[d.unit]

/** O que a conexão aceita: resposta rápida nativa ou, sem ela, botões de toque (o motor adapta). null = sem clique. */
export function quickReplyLimits(profile: QuickReplyProfile): QuickReplyLimits | null {
  if (profile.quickReplies) return { max: Math.min(QUICK_REPLY_MAX, profile.quickReplies.max), titleMax: Math.min(QUICK_REPLY_TITLE_MAX, profile.quickReplies.titleMax), native: true }
  if (profile.buttons.types.includes('postback') && profile.buttons.maxPerMessage > 0)
    return { max: Math.min(QUICK_REPLY_MAX, profile.buttons.maxPerMessage), titleMax: Math.min(QUICK_REPLY_TITLE_MAX, profile.buttons.titleMax), native: false }
  return null
}

type Settings = { click_timeout?: Duration; reply_attempts?: number }
/** Mensagem inteira: as respostas rápidas e o resto do bloco precisam combinar. */
export function quickRepliesError(blocks: { kind?: unknown; label?: unknown; id?: unknown; skip?: unknown; text?: unknown }[],
  profiles: QuickReplyProfile[], settings: Settings = {}): string | undefined {
  const replies = blocks.filter(isQuickReply)
  if (!replies.length) return
  if (!profiles.length) return 'Escolha uma conexão compatível no gatilho.'
  if (blocks.some(b => b.kind === 'button')) return 'Botão e resposta rápida não coexistem no mesmo texto.'
  if (!blocks.some(b => b.kind === 'text' && typeof b.text === 'string' && b.text.trim())) return 'Respostas rápidas acompanham um texto da mensagem.'
  if (new Set(replies.map(r => r.id)).size !== replies.length) return 'Cada resposta rápida precisa de um identificador próprio.'
  if (replies.filter(r => r.skip).length > 1) return 'Use só uma resposta Pular.'
  for (const profile of profiles) {
    const limits = quickReplyLimits(profile)
    if (!limits) return 'Esta conexão não oferece resposta rápida.'
    if (replies.length > limits.max) return `Use até ${limits.max} respostas rápidas nesta conexão.`
    for (const r of replies) {
      const label = typeof r.label === 'string' ? r.label.trim() : ''
      if (!label) return 'Dê um título a cada resposta rápida.'
      if ([...label].length > limits.titleMax) return `Título da resposta rápida deve ter até ${limits.titleMax} caracteres.`
    }
  }
  const attempts = settings.reply_attempts ?? 1
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > QUICK_REPLY_ATTEMPTS_MAX) return `Use de 1 a ${QUICK_REPLY_ATTEMPTS_MAX} tentativas.`
  const wait = settings.click_timeout ? durationMs(settings.click_timeout) : QUICK_REPLY_WINDOW_MS / attempts
  if (!(wait > 0) || wait * attempts > QUICK_REPLY_WINDOW_MS) return 'O tempo total de espera por tentativa não pode passar de 24 horas.'
}

/** Quanto esperar por toque em cada tentativa (padrão: a janela de 24 h dividida pelas tentativas). */
export function quickReplyWaitMs(settings: Settings): number {
  const attempts = settings.reply_attempts ?? 1
  return settings.click_timeout ? durationMs(settings.click_timeout) : Math.floor(QUICK_REPLY_WINDOW_MS / attempts)
}
