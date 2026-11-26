import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { channelKinds, type ChannelType } from '../channels/types'
import { triggerTypeSql } from '../../../shared/trigger-types'
import type { Env } from '../env'
import { authorize, type Principal } from '../permissions'
import { assertWorkspace } from './shared'
import { effectiveStateSql, stateInSql } from '../channels/core/connection-state'

/** Query de /dashboard, /insights e /insights/inbox. Sem `from`/`to`, o handler usa os últimos 7 dias até agora (calculado na hora). */
export const analyticsQuerySchema = z.object({
  from: z.coerce.number().int().min(0).optional().describe('Início do período em segundos Unix (padrão: 7 dias atrás).'),
  to: z.coerce.number().int().min(1).optional().describe('Fim do período em segundos Unix (padrão: agora). O período vai até 365 dias.'),
  channel: z.enum(channelKinds).optional().describe('Só um canal.'),
}).strict()

export type InsightsFilter = { from: number; to: number; channel?: ChannelType }
export type DashboardSummary = {
  reference_at: string; period_days: number; from: number; to: number
  metrics: { key: 'contacts' | 'new_contacts' | 'open_conversations' | 'live_automations'; label: string; value: number; delta: number | null; comparison: string }[]
  most_used: { id: string; name: string; status: 'draft' | 'live' | 'stopped'; runs: number; unique_contacts: number }[]
  empty: boolean
  /** Primeiros passos: cada um feito ou não, pelo estado real do espaço. */
  checklist: { key: 'connect' | 'automation' | 'publish' | 'first_contact' | 'team'; label: string; done: boolean }[]
  channels: { id: string; name: string; type: string; status: string }[]
  /** Tempo que as automações pouparam: mensagens automáticas enviadas no período por tipo de entrada, a 1 minuto de atendimento cada. */
  time_saved: { minutes: number; by_type: { type: 'dm' | 'comment' | 'story' | 'other'; messages: number }[] }
  most_engaged: { contact_id: string; name: string; messages: number }[]
}
export type InsightsPoint = { date: string; contacts: number; messages: number; clicks: number; new_contacts: number; unsubscribed: number; net: number }
export type InsightsReport = {
  period: number; from: number; to: number; points: InsightsPoint[]
  automations: { id: string; name: string; contacts: number; messages: number; clicks: number; conversions: number; revenue: number }[]
  totals: { contacts: number; messages: number; clicks: number; clickRate: number | null; delivered: number; read: number; emails_collected: number;
    new_contacts: number; unsubscribed: number; net: number; inactive: number; runs: number }
  by_channel: { channel: string; contacts: number; messages: number }[]
  conversions: { events: { name: string; count: number }[]; revenue: { currency: string; value: number }[] }
  metadata: { contacts: 'unique_active'; automation_messages: 'sent_nodes'; timezone: 'UTC' }
}
type InsightsEnv = Pick<Env, 'DB'>
const DAY = 86400
const channelTypes: readonly string[] = channelKinds
function parameters(principal: Principal, filter: InsightsFilter) {
  authorize(principal, 'automation:read')
  assertWorkspace(principal.workspaceId)
  if (!Number.isSafeInteger(filter.from) || !Number.isSafeInteger(filter.to) || filter.from < 0
    || filter.to <= filter.from || filter.to - filter.from > 366 * DAY
    || (filter.channel !== undefined && !channelTypes.includes(filter.channel))) {
    throw new HTTPException(400, { message: 'Informe um período válido de até 366 dias e um canal disponível.' })
  }
  return [principal.workspaceId, filter.from * 1000, filter.to * 1000, filter.channel ?? null, filter.channel ?? null] as const
}
// Every join includes the tenant. Notes, timeline events, pending and failed sends are not messages sent.
const realMessage = `coalesce(json_extract(m.content,'$.sender'),m.source) NOT IN ('system','note')
  AND (m.direction='in' OR (m.direction='out' AND m.external_message_id IS NOT NULL
    AND coalesce(json_extract(m.content,'$.status'),'sent') IN ('sent','delivered','read')))`
const messageActivity = `SELECT cc.contact_id,m.created_at,m.direction FROM messages m
  JOIN conversations v ON v.workspace_id=m.workspace_id AND v.id=m.conversation_id
  JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
  JOIN channels h ON h.workspace_id=cc.workspace_id AND h.id=cc.channel_id
  WHERE m.workspace_id=? AND m.created_at>=? AND m.created_at<? AND (? IS NULL OR h.type=?) AND ${realMessage}`
const eventActivity = `SELECT n.contact_id,n.created_at,n.automation_id,n.type FROM node_events n
  LEFT JOIN flow_runs r ON r.workspace_id=n.workspace_id AND r.id=n.flow_run_id
  LEFT JOIN channels h ON h.workspace_id=r.workspace_id AND h.id=r.channel_id
  WHERE n.workspace_id=? AND n.created_at>=? AND n.created_at<? AND (? IS NULL OR h.type=?)`
const runActivity = `SELECT r.contact_id,r.created_at,av.automation_id FROM flow_runs r
  JOIN automation_versions av ON av.workspace_id=r.workspace_id AND av.id=r.automation_version_id
  LEFT JOIN channels h ON h.workspace_id=r.workspace_id AND h.id=r.channel_id
  WHERE r.workspace_id=? AND r.created_at>=? AND r.created_at<? AND (? IS NULL OR h.type=?)`

/** Half-open UTC period. Current stock/status cards do not claim a historical snapshot. */
export async function getDashboard(env: InsightsEnv, principal: Principal, filter: InsightsFilter): Promise<DashboardSummary> {
  const params = parameters(principal, filter)
  const [ws, from, to, channel] = params
  const contactScope = `c.workspace_id=? AND (? IS NULL OR EXISTS (SELECT 1 FROM contact_channels cc
    JOIN channels h ON h.workspace_id=cc.workspace_id AND h.id=cc.channel_id
    WHERE cc.workspace_id=c.workspace_id AND cc.contact_id=c.id AND h.type=?))`
  const automationScope = `a.workspace_id=? AND a.deleted_at IS NULL AND (? IS NULL OR EXISTS (SELECT 1 FROM triggers t
    JOIN channels h ON h.workspace_id=t.workspace_id AND h.id=t.channel_id
    WHERE t.workspace_id=a.workspace_id AND t.automation_id=a.id AND h.type=?))`
  // As oito leituras do painel não dependem umas das outras: uma onda só.
  const [contacts, automations, conversations, runs, steps, channelRows, saved, engaged] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total,
      coalesce(SUM(c.subscribed_at>=? AND c.subscribed_at<?),0) AS recent,
      coalesce(SUM(c.subscribed_at>=? AND c.subscribed_at<?),0) AS previous
      FROM contacts c WHERE c.status<>'deleted' AND ${contactScope}`).bind(from, to, from - (to - from), from, ws, channel, channel)
      .first<{ total: number; recent: number; previous: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS total,coalesce(SUM(a.status='live'),0) AS live FROM automations a WHERE ${automationScope}`)
      .bind(ws, channel, channel).first<{ total: number; live: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM conversations v
      JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
      JOIN channels h ON h.workspace_id=cc.workspace_id AND h.id=cc.channel_id
      WHERE v.workspace_id=? AND v.status='open' AND (? IS NULL OR h.type=?)
      AND EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id=v.workspace_id AND m.conversation_id=v.id
        AND m.created_at>=? AND m.created_at<? AND ${realMessage})`)
      .bind(ws, channel, channel, from, to).first<{ n: number }>(),
    env.DB.prepare(`WITH activity AS (${runActivity}) SELECT a.id,a.name,a.status,COUNT(*) AS runs,
      COUNT(DISTINCT r.contact_id) AS unique_contacts FROM activity r JOIN automations a
      ON a.workspace_id=? AND a.id=r.automation_id AND a.deleted_at IS NULL GROUP BY a.id,a.name,a.status
      ORDER BY runs DESC,a.name,a.id LIMIT 5`).bind(...params, ws).all<DashboardSummary['most_used'][number]>(),
    env.DB.prepare(`SELECT (SELECT COUNT(*) FROM channels WHERE workspace_id=?1 AND ${stateInSql(['connected'])} AND archived_at IS NULL) AS connected,
      (SELECT COUNT(*) FROM automations WHERE workspace_id=?1 AND deleted_at IS NULL) AS automations,
      (SELECT COUNT(*) FROM automations WHERE workspace_id=?1 AND deleted_at IS NULL AND published_version_id IS NOT NULL) AS published,
      (SELECT COUNT(*) FROM contacts WHERE workspace_id=?1 AND status<>'deleted') AS contacts,
      (SELECT COUNT(*) FROM workspace_members WHERE workspace_id=?1) AS members`).bind(ws)
      .first<{ connected: number; automations: number; published: number; contacts: number; members: number }>(),
    env.DB.prepare(`SELECT id,coalesce(display_name,id) AS name,type,${effectiveStateSql()} AS status FROM channels WHERE workspace_id=? AND archived_at IS NULL ORDER BY created_at,id LIMIT 20`).bind(ws)
      .all<{ id: string; name: string; type: string; status: string }>(),
    env.DB.prepare(`SELECT CASE WHEN t.id IS NULL THEN 'other' WHEN (${triggerTypeSql('t')}) IN ('ig_comment','ig_live_comment') THEN 'comment'
        WHEN (${triggerTypeSql('t')}) IN ('ig_story_reply','ig_story_mention','ig_share_to_dm') THEN 'story'
        WHEN (${triggerTypeSql('t')}) IN ('dm_keyword','default_reply','welcome') THEN 'dm' ELSE 'other' END AS entry_type,COUNT(*) AS messages
      FROM node_events n JOIN flow_runs r ON r.workspace_id=n.workspace_id AND r.id=n.flow_run_id LEFT JOIN triggers t ON t.workspace_id=r.workspace_id AND t.id=r.trigger_id
      LEFT JOIN channels h ON h.workspace_id=r.workspace_id AND h.id=r.channel_id
      WHERE n.workspace_id=? AND n.type='sent' AND n.created_at>=? AND n.created_at<? AND (? IS NULL OR h.type=?) GROUP BY entry_type`).bind(ws, from, to, channel, channel)
      .all<{ entry_type: 'dm' | 'comment' | 'story' | 'other'; messages: number }>(),
    env.DB.prepare(`SELECT c.id AS contact_id,trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')) AS name,COUNT(*) AS messages FROM messages m
      JOIN conversations v ON v.workspace_id=m.workspace_id AND v.id=m.conversation_id JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
      JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id AND c.status<>'deleted' JOIN channels h ON h.workspace_id=cc.workspace_id AND h.id=cc.channel_id
      WHERE m.workspace_id=? AND m.direction='in' AND m.created_at>=? AND m.created_at<? AND (? IS NULL OR h.type=?)
      GROUP BY c.id ORDER BY messages DESC,c.id LIMIT 5`).bind(ws, from, to, channel, channel).all<{ contact_id: string; name: string; messages: number }>(),
  ])
  const count = contacts ?? { total: 0, recent: 0, previous: 0 }
  const checklist: DashboardSummary['checklist'] = [
    { key: 'connect', label: 'Conectar um canal', done: (steps?.connected ?? 0) > 0 },
    { key: 'automation', label: 'Criar a primeira automação', done: (steps?.automations ?? 0) > 0 },
    { key: 'publish', label: 'Publicar uma automação', done: (steps?.published ?? 0) > 0 },
    { key: 'first_contact', label: 'Receber o primeiro contato', done: (steps?.contacts ?? 0) > 0 },
    { key: 'team', label: 'Convidar alguém da equipe', done: (steps?.members ?? 0) > 1 },
  ]
  const savedMessages = saved.results.reduce((n, r) => n + r.messages, 0)
  return {
    checklist, channels: channelRows.results, most_engaged: engaged.results.map(e => ({ ...e, name: e.name || 'Contato sem nome' })),
    time_saved: { minutes: savedMessages, by_type: saved.results.map(r => ({ type: r.entry_type, messages: r.messages })) },
    reference_at: new Date().toISOString(), period_days: Math.ceil((filter.to - filter.from) / DAY), from: filter.from, to: filter.to,
    metrics: [
      { key: 'contacts', label: 'Contatos na base', value: count.total, delta: count.recent, comparison: 'adicionados no período selecionado' },
      { key: 'new_contacts', label: 'Novos contatos', value: count.recent, delta: count.recent - count.previous, comparison: 'em relação ao período anterior de mesma duração' },
      { key: 'open_conversations', label: 'Conversas abertas', value: conversations?.n ?? 0, delta: null, comparison: 'abertas agora e com atividade no período; sem histórico comparável' },
      { key: 'live_automations', label: 'Automações ativas', value: automations?.live ?? 0, delta: null, comparison: 'estado atual; sem histórico comparável' },
    ],
    most_used: runs.results, empty: count.total === 0 && (automations?.total ?? 0) === 0,
  }
}

/** Messages are confirmed outbound records; automation rows count sent node events because messages lack a run foreign key. */
export async function getInsights(env: InsightsEnv, principal: Principal, filter: InsightsFilter): Promise<InsightsReport> {
  const params = parameters(principal, filter)
  const [ws, from, to, channel] = params
  const scoped = `c.workspace_id=? AND (? IS NULL OR EXISTS (SELECT 1 FROM contact_channels cc JOIN channels h ON h.workspace_id=cc.workspace_id AND h.id=cc.channel_id
    WHERE cc.workspace_id=c.workspace_id AND cc.contact_id=c.id AND h.type=?))`
  const day = (column: string) => `strftime('%Y-%m-%d',${column}/1000.0,'unixepoch')`
  // As quatorze leituras do relatório não dependem umas das outras: uma onda só.
  const [growthNew, growthOut, stock, delivery, emails, byChannel, conversions, revenue, perAutomation, runs, contacts, messages, clicks, automations] = await Promise.all([
    env.DB.prepare(`SELECT ${day('c.subscribed_at')} AS date,COUNT(*) AS n FROM contacts c WHERE ${scoped} AND c.subscribed_at>=? AND c.subscribed_at<? GROUP BY date`).bind(ws, channel, channel, from, to).all<{ date: string; n: number }>(),
    env.DB.prepare(`SELECT ${day('c.unsubscribed_at')} AS date,COUNT(*) AS n FROM contacts c WHERE ${scoped} AND c.unsubscribed_at>=? AND c.unsubscribed_at<? GROUP BY date`).bind(ws, channel, channel, from, to).all<{ date: string; n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM contacts c WHERE ${scoped} AND c.status='subscribed' AND c.subscribed_at<?`).bind(ws, channel, channel, to).first<number>('n'),
    env.DB.prepare(`SELECT SUM(m.delivery_status IN ('delivered','read')) AS delivered,SUM(m.delivery_status='read') AS read FROM (${messageActivity.replace('SELECT cc.contact_id,m.created_at,m.direction', 'SELECT m.delivery_status,m.direction')}) m WHERE m.direction='out'`)
      .bind(...params).first<{ delivered: number | null; read: number | null }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM contacts c WHERE ${scoped} AND c.email_collected_at>=? AND c.email_collected_at<?`).bind(ws, channel, channel, from, to).first<number>('n'),
    env.DB.prepare(`SELECT h.type AS channel,COUNT(DISTINCT cc.contact_id) AS contacts,SUM(m.direction='out') AS messages FROM messages m
      JOIN conversations v ON v.workspace_id=m.workspace_id AND v.id=m.conversation_id JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
      JOIN channels h ON h.workspace_id=cc.workspace_id AND h.id=cc.channel_id
      WHERE m.workspace_id=? AND m.created_at>=? AND m.created_at<? AND (? IS NULL OR h.type=?) AND ${realMessage} GROUP BY h.type ORDER BY contacts DESC`).bind(...params).all<{ channel: string; contacts: number; messages: number }>(),
    env.DB.prepare(`SELECT e.event_name AS name,COUNT(*) AS count FROM conversion_events e LEFT JOIN flow_runs r ON r.workspace_id=e.workspace_id AND r.id=e.run_id
      LEFT JOIN channels h ON h.workspace_id=r.workspace_id AND h.id=r.channel_id WHERE e.workspace_id=? AND e.created_at>=? AND e.created_at<? AND (? IS NULL OR h.type=?) GROUP BY e.event_name ORDER BY count DESC LIMIT 50`).bind(...params).all<{ name: string; count: number }>(),
    env.DB.prepare(`SELECT e.currency,SUM(coalesce(e.value,0)) AS value FROM conversion_events e LEFT JOIN flow_runs r ON r.workspace_id=e.workspace_id AND r.id=e.run_id
      LEFT JOIN channels h ON h.workspace_id=r.workspace_id AND h.id=r.channel_id WHERE e.workspace_id=? AND e.created_at>=? AND e.created_at<? AND (? IS NULL OR h.type=?) AND e.value IS NOT NULL GROUP BY e.currency ORDER BY e.currency`).bind(...params).all<{ currency: string; value: number }>(),
    env.DB.prepare(`SELECT e.automation_id,COUNT(*) AS conversions,SUM(coalesce(e.value,0)) AS revenue FROM conversion_events e WHERE e.workspace_id=? AND e.created_at>=? AND e.created_at<? GROUP BY e.automation_id`)
      .bind(ws, from, to).all<{ automation_id: string; conversions: number; revenue: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM (${runActivity})`).bind(...params).first<number>('n'),
    env.DB.prepare(`WITH activity AS (
      SELECT contact_id,created_at FROM (${messageActivity}) UNION ALL
      SELECT contact_id,created_at FROM (${eventActivity}) UNION ALL
      SELECT contact_id,created_at FROM (${runActivity})
    ) SELECT strftime('%Y-%m-%d',created_at/1000.0,'unixepoch') AS date,COUNT(DISTINCT contact_id) AS n FROM activity GROUP BY date
      UNION ALL SELECT NULL,COUNT(DISTINCT contact_id) FROM activity`)
      .bind(...params, ...params, ...params).all<{ date: string | null; n: number }>(),
    env.DB.prepare(`SELECT strftime('%Y-%m-%d',created_at/1000.0,'unixepoch') AS date,COUNT(*) AS n
      FROM (${messageActivity}) WHERE direction='out' GROUP BY date`).bind(...params).all<{ date: string; n: number }>(),
    env.DB.prepare(`SELECT strftime('%Y-%m-%d',created_at/1000.0,'unixepoch') AS date,COUNT(*) AS n
      FROM (${eventActivity}) WHERE type='clicked' GROUP BY date`).bind(...params).all<{ date: string; n: number }>(),
    env.DB.prepare(`WITH events AS (${eventActivity}),runs AS (${runActivity}),
      activity AS (SELECT automation_id,contact_id FROM events UNION ALL SELECT automation_id,contact_id FROM runs),
      contacts AS (SELECT automation_id,COUNT(DISTINCT contact_id) AS n FROM activity GROUP BY automation_id),
      counts AS (SELECT automation_id,SUM(type='sent') AS messages,SUM(type='clicked') AS clicks FROM events GROUP BY automation_id)
      SELECT a.id,a.name,c.n AS contacts,coalesce(e.messages,0) AS messages,coalesce(e.clicks,0) AS clicks
      FROM contacts c JOIN automations a ON a.workspace_id=? AND a.id=c.automation_id AND a.deleted_at IS NULL
      LEFT JOIN counts e ON e.automation_id=c.automation_id ORDER BY messages DESC,a.name,a.id`)
      .bind(...params, ...params, principal.workspaceId).all<InsightsReport['automations'][number]>(),
  ])
  const series = new Map<string, InsightsPoint>()
  for (let day = Math.floor(filter.from / DAY) * DAY; day < filter.to; day += DAY) {
    const date = new Date(day * 1000).toISOString().slice(0, 10)
    series.set(date, { date, contacts: 0, messages: 0, clicks: 0, new_contacts: 0, unsubscribed: 0, net: 0 })
  }
  for (const [metric, result] of [['new_contacts', growthNew], ['unsubscribed', growthOut]] as const) {
    for (const row of result.results) { const point = series.get(row.date); if (point) point[metric] = row.n }
  }
  for (const point of series.values()) point.net = point.new_contacts - point.unsubscribed
  for (const [metric, result] of [['contacts', contacts], ['messages', messages], ['clicks', clicks]] as const) {
    for (const row of result.results) if (row.date !== null) {
      const point = series.get(row.date)
      if (point) point[metric] = row.n
    }
  }
  const points = [...series.values()]
  const active = contacts.results.find(r => r.date === null)?.n ?? 0
  const sum = (key: 'messages' | 'clicks' | 'new_contacts' | 'unsubscribed') => points.reduce((n, p) => n + p[key], 0)
  const totals = { contacts: active, messages: sum('messages'), clicks: sum('clicks'), delivered: delivery?.delivered ?? 0, read: delivery?.read ?? 0,
    emails_collected: emails ?? 0, new_contacts: sum('new_contacts'), unsubscribed: sum('unsubscribed'), net: sum('new_contacts') - sum('unsubscribed'),
    inactive: Math.max(0, (stock ?? 0) - active), runs: runs ?? 0 }
  const byAutomation = new Map(perAutomation.results.map(r => [r.automation_id, r]))
  return { period: Math.ceil((filter.to - filter.from) / DAY), from: filter.from, to: filter.to, points,
    automations: automations.results.map(a => ({ ...a, conversions: byAutomation.get(a.id)?.conversions ?? 0, revenue: byAutomation.get(a.id)?.revenue ?? 0 })),
    totals: { ...totals, clickRate: totals.messages ? totals.clicks / totals.messages : null },
    by_channel: byChannel.results, conversions: { events: conversions.results, revenue: revenue.results },
    metadata: { contacts: 'unique_active', automation_messages: 'sent_nodes', timezone: 'UTC' } }
}

export type InboxInsights = {
  from: number; to: number
  conversations: number; answered: number; response_rate: number | null
  first_response_seconds: number | null; close_seconds: number | null
  agents: { member_id: string; name: string; assigned: number; closed: number }[]
}
/** Caixa de entrada no período (até 3 meses): conversas com mensagem do contato, quantas a equipe respondeu, tempo da 1ª resposta humana,
 *  tempo até encerrar (desde a 1ª mensagem do período) e o trabalho por atendente. Atendente lê: é a análise do próprio atendimento. */
export async function getInboxInsights(env: InsightsEnv, principal: Principal, filter: { from: number; to: number }): Promise<InboxInsights> {
  authorize(principal, 'read')
  if (!Number.isSafeInteger(filter.from) || !Number.isSafeInteger(filter.to) || filter.to <= filter.from || filter.to - filter.from > 93 * DAY)
    throw new HTTPException(400, { message: 'Informe um período válido de até 3 meses.' })
  const ws = principal.workspaceId, from = filter.from * 1000, to = filter.to * 1000
  const human = `coalesce(json_extract(m.content,'$.sender'),m.source)='human'`
  const [summary, agents] = await Promise.all([
    env.DB.prepare(`WITH firsts AS (SELECT m.conversation_id,MIN(m.created_at) AS first_in FROM messages m WHERE m.workspace_id=? AND m.direction='in' AND m.created_at>=? AND m.created_at<? GROUP BY m.conversation_id),
      replies AS (SELECT f.conversation_id,f.first_in,(SELECT MIN(m.created_at) FROM messages m WHERE m.workspace_id=? AND m.conversation_id=f.conversation_id AND m.direction='out' AND ${human} AND m.created_at>=f.first_in) AS first_reply FROM firsts f)
      SELECT COUNT(*) AS conversations,SUM(r.first_reply IS NOT NULL) AS answered,AVG((r.first_reply-r.first_in)/1000.0) AS first_response,
        AVG(CASE WHEN v.closed_at>=r.first_in THEN (v.closed_at-r.first_in)/1000.0 END) AS close_time
      FROM replies r JOIN conversations v ON v.workspace_id=? AND v.id=r.conversation_id`).bind(ws, from, to, ws, ws)
      .first<{ conversations: number; answered: number | null; first_response: number | null; close_time: number | null }>(),
    env.DB.prepare(`SELECT wm.id AS member_id,coalesce(nullif(u.name,''),u.email) AS name,
        (SELECT COUNT(*) FROM conversations v WHERE v.workspace_id=wm.workspace_id AND v.assignee_id=wm.id AND EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id=v.workspace_id AND m.conversation_id=v.id AND m.created_at>=? AND m.created_at<?)) AS assigned,
        (SELECT COUNT(*) FROM conversations v WHERE v.workspace_id=wm.workspace_id AND v.assignee_id=wm.id AND v.closed_at>=? AND v.closed_at<?) AS closed
      FROM workspace_members wm JOIN "user" u ON u.id=wm.user_id WHERE wm.workspace_id=? AND (wm.inbox_seat=1 OR wm.role='owner') ORDER BY name`).bind(from, to, from, to, ws)
      .all<{ member_id: string; name: string; assigned: number; closed: number }>(),
  ])
  const conversations = summary?.conversations ?? 0, answered = summary?.answered ?? 0
  return { from: filter.from, to: filter.to, conversations, answered, response_rate: conversations ? answered / conversations : null,
    first_response_seconds: summary?.first_response == null ? null : Math.round(summary.first_response),
    close_seconds: summary?.close_time == null ? null : Math.round(summary.close_time),
    agents: agents.results }
}
