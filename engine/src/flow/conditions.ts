import { dynamicConfigSchema } from './dynamic-block'
import { flowConditionSchema, smartDelaySchema, type FlowCondition } from '../schemas/temporal'
import { matchesContact, contactFilterSql } from '../email-channel/filters'
import { assertBotRule, matchesBotValue } from './bot-field-condition'
import { isExtendedSystemField } from '../db/system-extended-clause'
import { flowTimezone, readDate, shiftDate, localDate, inTimeWindow } from './timing'

type Context = { workspace_id: string; contact_id: string }
export async function matchesFlowCondition(db: D1Database, context: Context, input: unknown): Promise<boolean> {
  if (input && typeof input === 'object' && !Object.keys(input).length) return true
  const filter = flowConditionSchema.parse(input), now = Date.now()
  if (!filter.rules.length) return true
  const evaluate = async (group: FlowCondition): Promise<boolean> => {
    const values: boolean[] = []
    for (const rule of group.rules) {
      if ('rules' in rule) { values.push(await evaluate(rule)); continue }
      if (rule.type === 'any_tag') {
        const has = !!await db.prepare('SELECT 1 FROM contact_tags WHERE workspace_id=? AND contact_id=? AND tag_id IN (SELECT value FROM json_each(?)) LIMIT 1')
          .bind(context.workspace_id, context.contact_id, JSON.stringify(rule.tag_ids)).first()
        values.push(rule.operator === 'has' ? has : !has)
      } else if (rule.type === 'topic') {
        const has = !!await db.prepare("SELECT 1 FROM topic_subscriptions WHERE workspace_id=? AND contact_id=? AND (? IS NULL OR topic_id=?) AND status='subscribed' AND expires_at>? LIMIT 1")
          .bind(context.workspace_id, context.contact_id, rule.topic_id ?? null, rule.topic_id ?? null, now).first()
        values.push(rule.operator === 'has' ? has : !has)
      } else if (rule.type === 'sequence') {
        const enrolled = !!await db.prepare('SELECT 1 FROM sequence_subscriptions WHERE workspace_id=? AND contact_id=? AND sequence_id=?')
          .bind(context.workspace_id, context.contact_id, rule.sequence_id).first()
        values.push(rule.operator === 'has' ? enrolled : !enrolled)
      } else if (rule.type === 'origin') {
        // Primeira passagem do contato com gatilho: é a origem dele, mesmo que depois entre por outros caminhos.
        const first = await db.prepare('SELECT t.kind, t.widget_type FROM flow_runs r JOIN triggers t ON t.workspace_id=r.workspace_id AND t.id=r.trigger_id WHERE r.workspace_id=? AND r.contact_id=? ORDER BY r.created_at, r.id LIMIT 1')
          .bind(context.workspace_id, context.contact_id).first<{ kind: string; widget_type: string | null }>()
        const matches = !!first && (first.kind === rule.origin || first.widget_type === rule.origin)
        values.push(rule.operator === 'is' ? matches : !matches)
      } else if (rule.type === 'bot_field') {
        // Campo do bot é valor global do espaço: não depende do contato.
        const field = await db.prepare("SELECT type,bot_value FROM custom_fields WHERE workspace_id=? AND id=? AND scope='bot' AND archived=0")
          .bind(context.workspace_id, rule.field_id).first<{ type: string; bot_value: string | null }>()
        values.push(!!field && matchesBotValue(field.type, field.bot_value, rule.operator, rule.value))
      } else if (rule.type === 'current_time') {
        values.push(inTimeWindow(now, rule.window, await flowTimezone(db, context, rule.timezone, false)))
      } else if (rule.type === 'date') {
        const timezone = await flowTimezone(db, context, rule.timezone)
        const left = await readDate(db, context, { kind: 'field', field_id: rule.field_id }, timezone)
        const rawRight = await readDate(db, context, rule.compare, timezone)
        const right = rawRight === null ? null : shiftDate(rawRight, rule.offset, timezone)
        values.push(left !== null && right !== null && (rule.operator === 'before' ? left < right : rule.operator === 'after' ? left > right : localDate(left, timezone) === localDate(right, timezone)))
      } else values.push(await matchesContact(db, context.workspace_id, context.contact_id, { match: 'all', rules: [rule] }))
    }
    return group.match === 'all' ? values.every(Boolean) : values.some(Boolean)
  }
  return evaluate(filter)
}

/** Resolve every saved reference in this workspace before a new immutable version is published. */
export async function validateLogicReferences(db: D1Database, workspace: string, type: string, input: unknown) {
  const dateField = async (id: string) => {
    const field = await db.prepare("SELECT type FROM custom_fields WHERE workspace_id=? AND id=? AND type IN ('date','datetime') AND scope='contact' AND archived=0").bind(workspace, id).first<{ type: string }>()
    if (!field) throw new Error('Escolha um campo de data de contato ativo neste espaço.')
    return field.type
  }
  if (type === 'dynamic') {
    if (!dynamicConfigSchema.safeParse(input).success) throw new Error('Informe o endereço https do servidor do bloco dinâmico.')
    return
  }
  if (type === 'template_message') {
    const id = (input as { template_id?: unknown } | null)?.template_id
    if (typeof id !== 'string' || !await db.prepare("SELECT 1 FROM message_templates WHERE workspace_id=? AND id=? AND status='approved'").bind(workspace, id).first())
      throw new Error('Escolha um modelo de mensagem aprovado.')
    return
  }
  if (type === 'smart_delay') {
    const config = smartDelaySchema.parse(input)
    if (config.mode === 'date' && config.date?.kind === 'field') await dateField(config.date.field_id)
    return
  }
  if (type !== 'condition' || input && typeof input === 'object' && !Object.keys(input).length) return
  const filter = flowConditionSchema.parse(input)
  for (const rule of filter.rules.flatMap(rule => 'rules' in rule ? rule.rules : [rule])) {
    if (rule.type === 'date') {
      const fieldType = await dateField(rule.field_id)
      if (rule.compare.kind === 'field' && fieldType !== await dateField(rule.compare.field_id)) throw new Error('Compare campos com o mesmo tipo de data.')
    }
    else if (rule.type === 'sequence') {
      if (!await db.prepare('SELECT id FROM sequences WHERE workspace_id=? AND id=?').bind(workspace, rule.sequence_id).first()) throw new Error('Escolha uma sequência neste espaço.')
    } else if (rule.type === 'segment') {
      // Compiling also checks nested references and prevents segment cycles.
      await contactFilterSql(db, workspace, { match: 'all', rules: [rule] })
    } else if (rule.type === 'any_tag') {
      const found = await db.prepare('SELECT count(*) AS n FROM tags WHERE workspace_id=? AND id IN (SELECT value FROM json_each(?))').bind(workspace, JSON.stringify(rule.tag_ids)).first<number>('n')
      if (found !== new Set(rule.tag_ids).size) throw new Error('Escolha etiquetas deste espaço.')
    } else if (rule.type === 'tag') {
      if (!await db.prepare('SELECT id FROM tags WHERE workspace_id=? AND id=?').bind(workspace, rule.tag_id).first()) throw new Error('Escolha uma etiqueta neste espaço.')
    } else if (rule.type === 'bot_field') {
      const field = await db.prepare("SELECT type FROM custom_fields WHERE workspace_id=? AND id=? AND scope='bot' AND archived=0").bind(workspace, rule.field_id).first<{ type: string }>()
      if (!field) throw new Error('Escolha um campo do bot ativo neste espaço.')
      assertBotRule(field.type, rule.operator, rule.value)
    } else if (rule.type === 'system_field' && isExtendedSystemField(rule.field)) {
      // Compilar valida operador e valor; dados fixos de e-mail e texto já passam pelo esquema.
      await contactFilterSql(db, workspace, { match: 'all', rules: [rule] })
    } else if (rule.type === 'field') {
      if (!await db.prepare("SELECT id FROM custom_fields WHERE workspace_id=? AND id=? AND scope='contact' AND archived=0").bind(workspace, rule.field_id).first()) throw new Error('Escolha um campo de contato ativo neste espaço.')
    }
  }
}
