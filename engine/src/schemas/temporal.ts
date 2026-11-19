import { z } from 'zod'
import { systemConditionFields, systemConditionOperators } from './system-fields'

export const timezoneSchema = z.string().refine(value => { try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true } catch { return false } }, 'Escolha um fuso horário válido.')
export const timeWindowSchema = z.object({
  from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(days => new Set(days).size === days.length),
}).refine(window => window.from !== window.to, 'O início e o fim da janela precisam ser diferentes.')
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.test(value) || !Number.isFinite(Date.parse(value))) return false
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
export const dateSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('specific'), at: z.string().refine(validDate, 'Informe uma data válida.') }),
  z.object({ kind: z.literal('field'), field_id: z.string().min(1) }),
])
export const dateOffsetSchema = z.object({ value: z.number().int().nonnegative(), unit: z.enum(['minutes', 'hours', 'days']), direction: z.enum(['before', 'after']) }).refine(offset => offset.value * { minutes: 60000, hours: 3600000, days: 86400000 }[offset.unit] <= 365 * 86400000, 'O deslocamento pode ser de até um ano.')
export const smartDelaySchema = z.object({
  mode: z.enum(['duration', 'date']).optional(),
  duration: z.object({ value: z.number().int().positive(), unit: z.enum(['seconds', 'minutes', 'hours', 'days']) }).optional(),
  date: dateSourceSchema.optional(), offset: dateOffsetSchema.optional(), window: timeWindowSchema.optional(), timezone: timezoneSchema.optional(),
}).passthrough().superRefine((config, ctx) => {
  if ((config.mode ?? 'duration') === 'date' ? !config.date : !config.duration) ctx.addIssue({ code: 'custom', message: 'Complete a data ou duração da espera.' })
  if (config.duration && config.duration.value * { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 }[config.duration.unit] > 365 * 86400000) ctx.addIssue({ code: 'custom', message: 'A espera pode durar até um ano.' })
})
/** Origem do contato: tipo do gatilho (ou do widget) da primeira passagem dele por uma automação. */
export const originKinds = ['widget', 'keyword', 'meta_keyword', 'rule', 'external_trigger', 'another_flow', 'default_reply', 'welcome_message', 'story_mention_reply', 'ice_breaker', 'main_menu', 'cart_reply'] as const
export const originWidgets = ['messenger_ref_url', 'ads', 'feed_comment', 'feed_comment_trigger', 'messenger_code', 'instagram_story_reply', 'instagram_share_to_story_reply', 'instagram_live_comment_reply', 'ctwa_trigger', 'tiktok_ads_ctx'] as const
const operators = z.enum(systemConditionOperators)
export const flowConditionLeafSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email'), filter: z.enum(['defined', 'undefined', 'opened', 'clicked', 'opened_clicked', 'opened_not_clicked', 'not_opened', 'subscribed', 'unsubscribed']) }),
  z.object({ type: z.literal('system_field'), field: z.enum(systemConditionFields), operator: operators, value: z.unknown().optional() }),
  z.object({ type: z.literal('tag'), tag_id: z.string().min(1), operator: z.enum(['has', 'not_has']) }),
  // Condição inteligente: tem (ou não tem) qualquer uma das etiquetas da lista.
  z.object({ type: z.literal('any_tag'), tag_ids: z.array(z.string().min(1)).min(1).max(20), operator: z.enum(['has', 'not_has']) }),
  z.object({ type: z.literal('field'), field_id: z.string().min(1), operator: operators, value: z.unknown().optional() }),
  // Campo do bot (valor global do espaço), comparado direto na Condição.
  z.object({ type: z.literal('bot_field'), field_id: z.string().min(1), operator: operators, value: z.unknown().optional() }),
  z.object({ type: z.literal('segment'), segment_id: z.string().min(1), operator: z.enum(['has', 'not_has', 'in', 'not_in']) }),
  z.object({ type: z.literal('sequence'), sequence_id: z.string().min(1), operator: z.enum(['has', 'not_has']) }),
  // Condição inteligente de notificação (smart_otn): o contato tem inscrição válida no tópico (sem tópico: em qualquer um).
  z.object({ type: z.literal('topic'), topic_id: z.string().min(1).optional(), operator: z.enum(['has', 'not_has']) }),
  z.object({ type: z.literal('origin'), origin: z.enum([...originKinds, ...originWidgets]), operator: z.enum(['is', 'is_not']) }),
  z.object({ type: z.literal('current_time'), window: timeWindowSchema, timezone: timezoneSchema.optional() }),
  z.object({ type: z.literal('date'), field_id: z.string().min(1), operator: z.enum(['before', 'after', 'equals']), compare: dateSourceSchema, offset: dateOffsetSchema.optional(), timezone: timezoneSchema.optional() }),
])
export const flowConditionSchema = z.object({ match: z.enum(['all', 'any']), rules: z.array(z.union([flowConditionLeafSchema,
  z.object({ match: z.enum(['all', 'any']), rules: z.array(flowConditionLeafSchema).min(1).max(30) }),
])).max(30) }).refine(filter => filter.rules.reduce((sum, rule) => sum + ('rules' in rule ? rule.rules.length : 1), 0) <= 30, 'Use até 30 condições.')
export type FlowCondition = z.infer<typeof flowConditionSchema>
