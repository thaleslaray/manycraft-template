import { z } from 'zod'
export const systemFields = ['first_name','last_name','email','phone','gender','locale','timezone'] as const
const id = z.string().min(1).max(128)
export const predicateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tag'), tag_id: id, operator: z.enum(['has', 'not_has']) }).strict(),
  z.object({ type: z.literal('field'), field_id: id, operator: z.enum(['equals','not_equals','contains','is_set','is_not_set','gt','gte','lt','lte']), value: z.unknown().optional() }).strict(),
])
const ruleShape = z.object({
  trigger: z.object({ type: z.enum(['tag_added','tag_removed','field_changed','contact_created','sequence_entered','date','system_field_changed','sequence_left']), field_id: id.optional(),
    repeat_yearly: z.boolean().optional(), offset_seconds: z.number().int().min(-31536000).max(31536000).optional(), at_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional() }).strict()
    .refine(v => v.type !== 'date' || !!v.field_id, 'Regras de data exigem um campo.'),
  event_filter: z.object({ tag_id: id.optional(), field_id: id.optional(), sequence_id: id.optional(), system_field: z.enum(systemFields).optional(), operator: z.enum(['equals','contains']).optional(), value: z.unknown().optional() }).strict().default({}),
  condition: z.object({ match: z.enum(['all','any']), groups: z.array(z.object({ match: z.enum(['all','any']), rules: z.array(predicateSchema).min(1).max(20) }).strict()).min(1).max(20) }).strict().nullable().optional(),
  actions: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('add_tag'), tag_id: id }).strict(), z.object({ type: z.literal('remove_tag'), tag_id: id }).strict(),
    z.object({ type: z.literal('set_custom_field_value'), field_id: id, value: z.unknown().refine(v => v !== undefined) }).strict(),
    z.object({ type: z.literal('unset_custom_field_value'), field_id: id }).strict(),
    z.object({ type: z.literal('add_to_sequence'), sequence_id: id }).strict(), z.object({ type: z.literal('remove_from_sequence'), sequence_id: id }).strict(),
    z.object({ type: z.literal('start_automation'), automation_id: id }).strict(),
  ])).min(1).max(30),
  frequency: z.enum(['once','always']).default('always'),
}).strict()
const systemFieldOnly = (v: z.infer<typeof ruleShape>) => !v.event_filter.system_field || v.trigger.type === 'system_field_changed'
const systemFieldMessage = 'O campo do sistema só vale no gatilho de campo do sistema.'
export const ruleConfigSchema = ruleShape.refine(systemFieldOnly, systemFieldMessage)
export const ruleInputSchema = ruleShape.extend({ name: z.string().trim().min(1).max(160) }).refine(systemFieldOnly, systemFieldMessage)
export type RuleConfig = z.infer<typeof ruleConfigSchema>
export type RuleInput = z.infer<typeof ruleInputSchema>
export type Rule = { id: string; name: string; active: boolean; draft: RuleConfig; published: RuleConfig | null; executions: number; unique_contacts: number; updated_at: string }
