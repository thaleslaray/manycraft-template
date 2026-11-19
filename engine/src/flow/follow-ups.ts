import { ensureWorkflow, hasFlow } from './dispatch'
import type { IntegrationEnv } from '../integrations'
import type { FlowEnv } from './types'

type DueFollowUp = { id: string; workspace_id: string; contact_id: string; channel_id: string; created_at: number; outcome: string | null; last_inbound: number | null; version: string | null }

/** Cron: follow-ups vencidos começam a automação escolhida, a menos que o contato tenha escrito depois do disparo.
 * A decisão de começar entra no mesmo lote que cria a execução, e done_at só é gravado depois que o Workflow existe:
 * uma falha em qualquer ponto deixa o follow-up vencido, e o minuto seguinte retoma de onde parou. */
export async function runDueFollowUps(env: IntegrationEnv, now = Date.now()) {
  if (!hasFlow(env)) return
  const due = await env.DB.prepare(`SELECT f.*,(SELECT max(cc.last_inbound_at) FROM contact_channels cc WHERE cc.workspace_id=f.workspace_id AND cc.contact_id=f.contact_id AND cc.channel_id=f.channel_id) AS last_inbound,
      (SELECT a.published_version_id FROM automations a WHERE a.workspace_id=f.workspace_id AND a.id=f.automation_id AND a.status='live' AND a.deleted_at IS NULL) AS version
    FROM trigger_follow_ups f WHERE f.done_at IS NULL AND f.due_at<=? ORDER BY f.due_at LIMIT 50`).bind(now).all<DueFollowUp>()
  // Cada um falha sozinho (fica vencido e não segura os de trás na fila); o primeiro erro ainda sobe para o cron registrar.
  const failures: unknown[] = []
  for (const f of due.results) await runFollowUp(env, f, now).catch(error => { failures.push(error) })
  if (failures.length) throw failures[0]
}

async function runFollowUp(env: FlowEnv, f: DueFollowUp, now: number) {
  const runId = `followup-${f.id}`
  // outcome já gravado com done_at vazio: a execução existe e o Workflow não (a criação falhou num minuto anterior); a decisão não muda.
  if (f.outcome === null) {
    const outcome = f.last_inbound !== null && f.last_inbound > f.created_at + 1000 ? 'replied' : !f.version ? 'unavailable' : 'started'
    if (outcome !== 'started') {
      await env.DB.prepare('UPDATE trigger_follow_ups SET done_at=?,outcome=? WHERE id=? AND done_at IS NULL AND outcome IS NULL').bind(now, outcome, f.id).run()
      return
    }
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id)
        SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM trigger_follow_ups WHERE id=? AND done_at IS NULL AND outcome IS NULL) ON CONFLICT(id) DO NOTHING`)
        .bind(runId, f.workspace_id, f.contact_id, f.version, f.channel_id, f.id),
      env.DB.prepare(`UPDATE trigger_follow_ups SET outcome='started' WHERE id=? AND done_at IS NULL AND outcome IS NULL
        AND EXISTS (SELECT 1 FROM flow_runs WHERE id=?)`).bind(f.id, runId),
    ])
  }
  if (await env.DB.prepare('SELECT id FROM flow_runs WHERE id=?').bind(runId).first()) await ensureWorkflow(env, runId)
  await env.DB.prepare("UPDATE trigger_follow_ups SET done_at=? WHERE id=? AND done_at IS NULL AND outcome='started'").bind(now, f.id).run()
}
