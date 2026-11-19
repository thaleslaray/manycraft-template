import { assertWorkspace, requireRow, type Row } from './shared'
import { effectiveProfile } from '../channels/core/profile-merge'
import type { ChannelKind, ProfilePatch, StoredProvider } from '../channels/contract'

export type Metric = 'runs' | 'optins' | 'sent' | 'delivered' | 'read' | 'clicked' | 'ctr'
export type MetricFilter = { period_days: number; trigger_id?: string }

/** As checagens saem em paralelo com a leitura de dados (`loaded`); quem chama espera `barrar()` antes de usar qualquer linha, então um 404 continua vindo antes dos números. */
function scope(db: D1Database, ws: string, id: string, trigger?: string) {
  assertWorkspace(ws)
  const checks = Promise.all([
    db.prepare('SELECT id FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL').bind(ws, id).first<Row>(),
    trigger ? db.prepare('SELECT id FROM triggers WHERE workspace_id=? AND automation_id=? AND id=?').bind(ws, id, trigger).first<Row>() : Promise.resolve(true),
  ])
  return async <T>(loaded: Promise<T>): Promise<T> => {
    loaded.catch(() => undefined)
    const [automation, found] = await checks
    requireRow(automation); requireRow(found)
    return loaded
  }
}

// Cohort = runs started in the period. Stages count contacts, not message nodes or button events.
// EXISTS keeps repeated receipts, repeated runs and multiple messages from inflating the funnel.
const cohort = `WITH cohort AS (
  SELECT r.* FROM flow_runs r JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id
  WHERE r.workspace_id=? AND v.automation_id=? AND r.created_at>=? AND (? IS NULL OR r.trigger_id=?)
), stages AS (
  SELECT r.*, ${['sent', 'delivered', 'read', 'clicked'].map(type => `EXISTS(SELECT 1 FROM node_events e WHERE e.workspace_id=r.workspace_id AND e.flow_run_id=r.id AND e.automation_id=? AND e.contact_id=r.contact_id AND e.type='${type}') AS ${type}`).join(', ')}
  FROM cohort r
)`
function values(ws: string, id: string, filter: MetricFilter) {
  return [ws, id, Date.now() - filter.period_days * 86400000, filter.trigger_id ?? null, filter.trigger_id ?? null, id, id, id, id]
}

export async function getAutomationTriggerMetrics(db: D1Database, ws: string, id: string, filter: MetricFilter) {
  const barrar = scope(db, ws, id, filter.trigger_id)
  const measurable = measurableTriggers(db, ws, id, filter)
  measurable.catch(() => undefined)
  const support = receiptSupport(db, ws, id, filter)
  support.catch(() => undefined)
  const row = await barrar(db.prepare(`${cohort} SELECT count(*) AS runs,
    count(DISTINCT CASE WHEN trigger_opt_in=1 THEN contact_id END) AS optins,
    ${['sent','delivered','read','clicked'].map(type => `count(DISTINCT CASE WHEN ${type}=1 THEN contact_id END) AS ${type}`).join(', ')},
    count(DISTINCT CASE WHEN clicked=1 AND contact_id IN (SELECT contact_id FROM stages WHERE sent=1) THEN contact_id END) AS clicked_sent,
    count(DISTINCT contact_id) AS unique_contacts,
    (SELECT count(*) FROM contacts c WHERE c.workspace_id=stages.workspace_id AND c.id IN (SELECT contact_id FROM stages) AND c.email IS NOT NULL) AS emails,
    (SELECT count(*) FROM contacts c WHERE c.workspace_id=stages.workspace_id AND c.id IN (SELECT contact_id FROM stages) AND c.phone IS NOT NULL) AS phones
    FROM stages`).bind(...values(ws, id, filter)).first<{ runs: number; optins: number; sent: number; delivered: number; read: number; clicked: number; clicked_sent: number; unique_contacts: number; emails: number; phones: number }>())
  const { clicked_sent, ...counts } = row!
  const receipts = await support
  return { ...counts, delivered: receipts.delivered ? counts.delivered : null, read: receipts.read ? counts.read : null,
    ctr: counts.sent ? clicked_sent / counts.sent : null, ...await impressions(db, ws, id, filter, await measurable) }
}

/** Entrega e leitura só são contadas quando ao menos uma conexão envolvida (a dos gatilhos e a das execuções do período) avisa;
 * sem nenhuma (Telegram, por exemplo), o número é null, e não um zero que parece falha. Sem conexão conhecida, conta como antes. */
async function receiptSupport(db: D1Database, ws: string, id: string, filter: MetricFilter): Promise<{ delivered: boolean; read: boolean }> {
  const trigger = filter.trigger_id ?? null
  const rows = await db.prepare(`SELECT ch.type,ch.provider,ch.capabilities_override FROM channels ch WHERE ch.workspace_id=? AND ch.id IN (
      SELECT t.channel_id FROM triggers t WHERE t.workspace_id=? AND t.automation_id=? AND (? IS NULL OR t.id=?)
      UNION SELECT r.channel_id FROM flow_runs r JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id
        WHERE r.workspace_id=? AND v.automation_id=? AND r.created_at>=? AND (? IS NULL OR r.trigger_id=?))`)
    .bind(ws, ws, id, trigger, trigger, ws, id, Date.now() - filter.period_days * 86400000, trigger, trigger)
    .all<{ type: ChannelKind; provider: StoredProvider; capabilities_override: string | null }>()
  if (!rows.results.length) return { delivered: true, read: true }
  const profiles = rows.results.map(r => effectiveProfile(r.type, r.provider, r.capabilities_override ? JSON.parse(r.capabilities_override) as ProfilePatch : undefined))
  return { delivered: profiles.some(p => p.receipts.delivered), read: profiles.some(p => p.receipts.read) }
}

// Só o link de referência do Messenger e do Instagram informa quando o gatilho foi exibido (o anúncio Click to WhatsApp entra aqui quando um canal o informar).
// Nos demais gatilhos (palavra-chave, comentário, boas-vindas...) o canal não avisa: impressions fica null.
function measurableTriggers(db: D1Database, ws: string, id: string, filter: MetricFilter) {
  const trigger = filter.trigger_id ?? null
  return db.prepare(`SELECT count(*) AS n FROM triggers t JOIN channels ch ON ch.workspace_id=t.workspace_id AND ch.id=t.channel_id
    WHERE t.workspace_id=? AND t.automation_id=? AND (? IS NULL OR t.id=?)
    AND t.kind='widget' AND t.widget_type='messenger_ref_url' AND ch.type IN ('messenger','instagram')`).bind(ws, id, trigger, trigger).first<{ n: number }>()
}
async function impressions(db: D1Database, ws: string, id: string, filter: MetricFilter, measurable: { n: number } | null) {
  const trigger = filter.trigger_id ?? null
  if (!measurable?.n) return { impressions: null }
  const row = await db.prepare(`SELECT count(*) AS n FROM trigger_impressions i JOIN triggers t ON t.workspace_id=i.workspace_id AND t.id=i.trigger_id
    WHERE i.workspace_id=? AND t.automation_id=? AND (? IS NULL OR i.trigger_id=?) AND i.occurred_at>=?`)
    .bind(ws, id, trigger, trigger, Date.now() - filter.period_days * 86400000).first<{ n: number }>()
  return { impressions: row!.n }
}

export async function recordTriggerImpressions(db: D1Database, ws: string, channelId: string, ref: string, eventKey: string, at = Date.now()) {
  await db.prepare(`INSERT INTO trigger_impressions(workspace_id,trigger_id,event_key,occurred_at)
    SELECT t.workspace_id,t.id,?,? FROM triggers t JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
    WHERE t.workspace_id=? AND t.channel_id=? AND t.kind='widget' AND t.widget_type='messenger_ref_url' AND t.status='active'
    AND a.deleted_at IS NULL AND coalesce(json_extract(t.config,'$.code'),json_extract(t.config,'$.ref'))=? ON CONFLICT(trigger_id,event_key) DO NOTHING`)
    .bind(eventKey, at, ws, channelId, ref).run()
}

export async function getAutomationMetricContacts(db: D1Database, ws: string, id: string, filter: MetricFilter & { metric: Metric; cursor?: string }) {
  const barrar = scope(db, ws, id, filter.trigger_id)
  const condition = filter.metric === 'runs' ? '1=1' : filter.metric === 'optins' ? 's.trigger_opt_in=1'
    : filter.metric === 'ctr' ? 's.clicked=1 AND s.contact_id IN (SELECT contact_id FROM stages WHERE sent=1)' : `s.${filter.metric}=1`
  const rows = await barrar(db.prepare(`${cohort} SELECT DISTINCT c.id,c.first_name,c.last_name,c.status FROM stages s
    JOIN contacts c ON c.workspace_id=s.workspace_id AND c.id=s.contact_id
    WHERE ${condition} AND c.id>? ORDER BY c.id LIMIT 31`)
    .bind(...values(ws, id, filter), filter.cursor ?? '').all<{ id: string; first_name: string | null; last_name: string | null; status: string }>())
  const contacts = rows.results.slice(0, 30)
  return { contacts, next_cursor: rows.results.length > 30 ? contacts.at(-1)!.id : null }
}
