import { phoneProblem } from '../../../shared/phone'
import { z } from 'zod'
import { consentChannels, consentChannelsByField } from '../channels/consent'

export const questionAnswerTypes = ['text', 'email', 'phone', 'number', 'multiple_choice', 'date', 'datetime', 'url', 'image', 'file', 'location'] as const
export const questionSchema = z.object({
  text: z.string().trim().min(1, 'Escreva a pergunta.').max(4096),
  answer_type: z.enum(questionAnswerTypes),
  field_id: z.string().min(1, 'Escolha o campo de destino.'),
  retry_message: z.string().trim().min(1, 'Escreva a mensagem de nova tentativa.').max(4096),
  max_attempts: z.number().int().min(1).max(10),
  skip: z.boolean().default(false),
  timeout: z.object({ value: z.number().int().positive(), unit: z.enum(['seconds', 'minutes', 'hours', 'days']) })
    .refine(d => d.value * { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 }[d.unit] <= 365 * 86400000, 'O tempo limite deve ser de até um ano.'),
  choices: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  /** Coleta com opt-in: canais que a resposta autoriza (ver consentChannelsByField). A frase é o consentimento mostrado ao contato. */
  opt_in: z.array(z.enum(consentChannels)).max(2).default([]),
  consent_phrase: z.string().trim().max(500).default(''),
}).superRefine((config, ctx) => {
  if (config.opt_in.length) {
    const allowed = consentChannelsByField[config.field_id] ?? []
    if (config.opt_in.some(c => !allowed.includes(c))) ctx.addIssue({ code: 'custom', path: ['opt_in'], message: 'Opt-in só vale para os canais do campo do sistema coletado (e-mail ou telefone).' })
    if (!config.consent_phrase) ctx.addIssue({ code: 'custom', path: ['consent_phrase'], message: 'Escreva a frase de consentimento que o contato vê.' })
  }
  if (config.answer_type === 'multiple_choice' && (config.choices.length < 2 || new Set(config.choices).size !== config.choices.length)) {
    ctx.addIssue({ code: 'custom', path: ['choices'], message: 'Informe de duas a dez opções diferentes.' })
  }
})
export type QuestionConfig = z.infer<typeof questionSchema>
/** Campos do sistema do contato que uma pergunta pode preencher, como na ManyChat. O id vai no mesmo `field_id`. */
export const questionSystemFields = {
  'system:email': { column: 'email', label: 'E-mail', answers: ['email'] },
  'system:phone': { column: 'phone', label: 'Telefone', answers: ['phone'] },
  'system:first_name': { column: 'first_name', label: 'Nome', answers: ['text'] },
  'system:last_name': { column: 'last_name', label: 'Sobrenome', answers: ['text'] },
} as const
export type QuestionSystemFieldId = keyof typeof questionSystemFields
export function questionSystemField(fieldId: string): (typeof questionSystemFields)[QuestionSystemFieldId] | undefined {
  return Object.hasOwn(questionSystemFields, fieldId) ? questionSystemFields[fieldId as QuestionSystemFieldId] : undefined
}
/** Campo do sistema escolhido e tipo de resposta combinam (e-mail só com e-mail, telefone só com telefone). */
export function questionSystemFieldFits(fieldId: string, answerType: string): boolean {
  return (questionSystemField(fieldId)?.answers as readonly string[] | undefined)?.includes(answerType) ?? false
}
/** An answer that is not text: a stored photo or file (its link) or a shared location (a map link). Audio, video and documents are all "file". */
export type QuestionAttachment = { kind: 'image' | 'file' | 'location'; value: string }
export function questionFieldType(answerType: string): 'text' | 'number' | 'date' | 'datetime' {
  return answerType === 'number' ? 'number' : answerType === 'date' ? 'date' : answerType === 'datetime' ? 'datetime' : 'text'
}
const defaultTimeZone = 'America/Sao_Paulo'
export function validTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone) return false
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: zone }); return true } catch { return false }
}
function zoneOffset(ms: number, zone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(Math.floor(ms / 1000) * 1000)).map(x => [x.type, Number(x.value)]))
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}
/** Data e hora como o contato escreveu: aceita 2026-10-24 14:30, 2026-10-24T14:30:15, 24/10/2026 14:30 e 24/10/2026 14h30, com Z ou +-HH:MM opcionais. Sem fuso na resposta vale o fuso do contato (ou da conta); devolve ISO em UTC. */
export function parseDateTimeAnswer(value: string, timeZone: string = defaultTimeZone): string | undefined {
  const text = value.trim().replace(/\s+/g, ' ')
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(text)
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),? (?:[àa]s )?(\d{1,2})(?::|h)(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/i.exec(text)
  const m = iso ? { y: iso[1], mo: iso[2], d: iso[3], h: iso[4], mi: iso[5], s: iso[6], off: iso[7] } : br ? { y: br[3], mo: br[2], d: br[1], h: br[4], mi: br[5], s: br[6], off: br[7] } : undefined
  if (!m) return undefined
  const [y, mo, d, h, mi, s] = [m.y, m.mo, m.d, m.h, m.mi, m.s ?? '0'].map(Number)
  const wall = Date.UTC(y, mo - 1, d, h, mi, s)
  const check = new Date(wall)
  if (h > 23 || mi > 59 || s > 59 || check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return undefined
  let utc: number
  if (m.off) {
    if (/^z$/i.test(m.off)) utc = wall
    else {
      const [, sign, oh, om] = /^([+-])(\d{2}):?(\d{2})$/.exec(m.off)!
      if (Number(oh) > 14 || Number(om) > 59) return undefined
      utc = wall - (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60000
    }
  } else {
    const zone = validTimeZone(timeZone) ? timeZone : defaultTimeZone
    utc = wall - zoneOffset(wall, zone)
    utc = wall - zoneOffset(utc, zone)
  }
  return Number.isFinite(utc) ? new Date(utc).toISOString() : undefined
}
/** Parse only the requested type; invalid input never falls back to a text field value. */
export function questionAnswer(config: QuestionConfig, raw: string, attachment?: QuestionAttachment, timeZone?: string): string | number | undefined {
  // Photo, file and location questions take the attachment only: what the person typed (a caption) is not the answer.
  if (config.answer_type === 'image') return attachment?.kind === 'image' ? attachment.value : undefined
  if (config.answer_type === 'file') return attachment && attachment.kind !== 'location' ? attachment.value : undefined
  if (config.answer_type === 'location') return attachment?.kind === 'location' ? attachment.value : undefined
  const value = raw.trim()
  if (!value) return undefined
  switch (config.answer_type) {
    case 'text': return value
    case 'email': return z.email().safeParse(value).success ? value : undefined
    case 'phone': {
      const phone = value.replace(/[\s().-]/g, '')
      return /^\+?[1-9]\d{7,14}$/.test(phone) && !phoneProblem(phone.replace(/^\+/, '')) ? phone : undefined
    }
    case 'number': return /^[+-]?\d+(?:[.,]\d+)?$/.test(value) && Number.isFinite(Number(value.replace(',', '.'))) ? Number(value.replace(',', '.')) : undefined
    case 'multiple_choice': return config.choices.includes(value) ? value : undefined
    case 'date': return z.iso.date().safeParse(value).success ? value : undefined
    case 'datetime': return parseDateTimeAnswer(value, timeZone)
    case 'url': return z.url({ protocol: /^https?$/ }).safeParse(value).success ? value : undefined
  }
}

export type QuestionCapabilities = {
  inbound?: { message?: boolean; media?: boolean }
  list?: { maxRows: number; rowTitleMax: number } | null
  buttons?: { types?: string[]; maxPerMessage?: number; titleMax?: number }
  quickReplies?: { max: number; titleMax: number } | null
}
/** More options than buttons allow still go out as a list when the connection has one: each option is a row, the pick comes back as a click. */
export function questionListFits(config: Pick<QuestionConfig, 'choices' | 'skip'>, caps: QuestionCapabilities): boolean {
  return !!caps.list && config.choices.length + Number(config.skip) <= caps.list.maxRows && config.choices.every(v => [...v].length <= caps.list!.rowTitleMax)
    && (!config.skip || caps.list.rowTitleMax >= 5)
}
export function questionCapabilityError(config: Pick<QuestionConfig, 'answer_type' | 'choices' | 'skip'>, caps: QuestionCapabilities): string | undefined {
  if (caps.inbound?.message !== true) return 'Esta conexão não recebe respostas a perguntas.'
  if (['image', 'file', 'location'].includes(config.answer_type)) return caps.inbound?.media === true ? undefined : 'Esta conexão não recebe fotos, arquivos nem localização.'
  if (config.answer_type !== 'multiple_choice') return
  if (questionListFits(config, caps)) return
  const buttons = caps.buttons
  if (buttons?.types?.includes('postback') && config.choices.length + Number(config.skip) <= (buttons.maxPerMessage ?? 0) && (!config.skip || (buttons.titleMax ?? 0) >= 5) && config.choices.every(v => [...v].length <= (buttons.titleMax ?? 0))) return
  if (caps.quickReplies && (!config.skip || caps.quickReplies.titleMax >= 5) && config.choices.length + Number(config.skip) <= caps.quickReplies.max && config.choices.every(v => [...v].length <= caps.quickReplies!.titleMax)) return
  return 'Múltipla escolha exige botões, lista ou respostas rápidas compatíveis com as opções.'
}
