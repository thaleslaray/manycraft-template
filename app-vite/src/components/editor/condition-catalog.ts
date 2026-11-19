import { emailOperatorsFor, emailSystemFields, isDateSystemField, systemFieldChoices } from "./email-condition"
import { defaultWindow } from "./temporal"
import type { ConditionRule } from "./graph"

export type RuleOption = { id: string; name: string }
export type RuleGroup = { label: string; options: RuleOption[] }

const system = (id: string) => `system:${id}`
const nameOf = (id: string) => emailSystemFields.find(field => field.id === id)?.name ?? id
const fromSystem = (...ids: string[]): RuleOption[] => ids.map(id => ({ id: system(id), name: nameOf(id) }))

/** Grupos do seletor de regra da Condição, na ordem em que aparecem. Os rótulos são nossos. */
export function ruleGroups(): RuleGroup[] {
  return [
    { label: "Recomendados", options: [{ id: "tag", name: "Verificar tag" }, { id: "email", name: "Atividade de e-mail" }, ...fromSystem("channel_follows_business")] },
    { label: "Filtros gerais", options: [{ id: "any_tag", name: "Qualquer uma das tags" }, { id: "segment", name: "Pertence a segmento" }, { id: "sequence", name: "Inscrição em sequência" },
      { id: "topic", name: "Tópico de notificação ativo" }, { id: "origin", name: "Origem do contato" }, { id: "current_time", name: "Horário atual" }, { id: "date", name: "Comparar datas" }] },
    { label: "Campos do sistema · Geral", options: fromSystem("first_name", "last_name", "status", "gender", "phone", "locale", "timezone", "last_input_text", "contact_id", "last_interaction_at", "window_open") },
    { label: "Campos do sistema · Instagram", options: fromSystem("channel_username", "channel_follower_count", "channel_verified", "opt_in_instagram") },
    { label: "Campos do sistema · WhatsApp", options: fromSystem("opt_in_whatsapp") },
    { label: "Campos do sistema · Messenger", options: fromSystem("opt_in_messenger") },
    { label: "Campos do sistema · Telegram", options: fromSystem("opt_in_telegram") },
    { label: "Campos do sistema · TikTok", options: fromSystem("opt_in_tiktok") },
    { label: "Campos do sistema · E-mail", options: fromSystem("email", "email_opens", "email_clicks", "email_last_opened_at", "email_last_clicked_at", "email_opted_in") },
    { label: "Campos do sistema · Anúncio", options: fromSystem("ad_source_id", "ad_headline", "ad_click_id", "ad_referred_at") },
    { label: "Campos do usuário", options: [{ id: "field", name: "Comparar campo do contato" }] },
    { label: "Campos do bot", options: [{ id: "bot_field", name: "Comparar campo do bot" }] },
  ]
}

/** Qual opção do seletor representa a regra. */
export const ruleOptionId = (rule: ConditionRule): string => rule.type === "system_field" ? system(rule.field) : rule.type

/** Regra inicial de um dado de sistema: a comparação e o valor mais comuns para o tipo. */
export function newSystemRule(field: string): Extract<ConditionRule, { type: "system_field" }> {
  const operators = emailOperatorsFor(field) as readonly string[]
  const operator = (operators.includes("equals") ? "equals" : operators[0]) as "equals"
  const type = emailSystemFields.find(item => item.id === field)?.type
  const choices = systemFieldChoices[field]
  if (field === "last_interaction_at") return { type: "system_field", field, operator: "within_days" as never, value: 7 }
  if (isDateSystemField(field)) return { type: "system_field", field, operator, value: Date.now() }
  return { type: "system_field", field, operator, value: choices ? choices[0].id : type === "boolean" ? true : type === "number" ? 0 : "" }
}

/** Regra nova ao escolher uma opção do seletor. */
export function newRule(optionId: string): ConditionRule {
  if (optionId.startsWith("system:")) return newSystemRule(optionId.slice(7))
  const type = optionId
  return type === "origin" ? { type, origin: "keyword", operator: "is" } : type === "sequence" ? { type, sequence_id: "", operator: "has" }
    : type === "current_time" ? { type, window: defaultWindow } : type === "date" ? { type, field_id: "", operator: "before", compare: { kind: "specific", at: "" } }
    : type === "tag" ? { type, tag_id: "", operator: "has" } : type === "any_tag" ? { type, tag_ids: [], operator: "has" } : type === "topic" ? { type, operator: "has" }
    : type === "email" ? { type: "email", filter: "defined" } : type === "segment" ? { type, segment_id: "", operator: "in" }
    : type === "bot_field" ? { type, field_id: "", operator: "equals", value: "" } : { type: "field", field_id: "", operator: "equals", value: "" }
}
