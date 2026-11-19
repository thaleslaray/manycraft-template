import type { Env } from '../env'
import { compileContactFilter } from '../db/contact-filter'
import { inboxMembers } from './team'

type Settings = { auto_assign: 'off' | 'basic' | 'advanced'; assign_limit: number | null }
export async function assignmentSettings(env: Pick<Env, 'DB'>, ws: string): Promise<Settings> {
  return await env.DB.prepare('SELECT auto_assign,assign_limit FROM inbox_settings WHERE workspace_id=?').bind(ws).first<Settings>() ?? { auto_assign: 'off', assign_limit: null }
}

/** Entre os candidatos, quem tem menos conversas abertas e ainda está abaixo do limite (empate: ordem estável por id). */
async function leastLoaded(env: Pick<Env, 'DB'>, ws: string, candidates: string[], limit: number | null): Promise<string | null> {
  if (!candidates.length) return null
  const load = await env.DB.prepare(`SELECT value AS id,(SELECT count(*) FROM conversations WHERE workspace_id=? AND status='open' AND assignee_id=j.value) AS open
    FROM json_each(?) j ORDER BY open,id`).bind(ws, JSON.stringify(candidates)).all<{ id: string; open: number }>()
  return load.results.find(row => limit === null || row.open < limit)?.id ?? null
}

/** Conversa aberta sem responsável que acabou de receber mensagem: escolhe quem atende pela preferência do espaço. Devolve o membro ou null. */
export async function autoAssign(env: Pick<Env, 'DB'>, ws: string, conversationId: string): Promise<string | null> {
  const settings = await assignmentSettings(env, ws)
  if (settings.auto_assign === 'off') return null
  const conversation = await env.DB.prepare(`SELECT v.assignee_id,v.status,cc.contact_id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
    WHERE v.workspace_id=? AND v.id=?`).bind(ws, conversationId).first<{ assignee_id: string | null; status: string; contact_id: string }>()
  if (!conversation || conversation.assignee_id || conversation.status !== 'open') return null
  const team = (await inboxMembers(env, ws)).map(m => m.id)
  let chosen: string | null = null
  if (settings.auto_assign === 'advanced') {
    const rules = await env.DB.prepare('SELECT condition,target_kind,target_id FROM inbox_assignment_rules WHERE workspace_id=? ORDER BY position,id').bind(ws)
      .all<{ condition: string; target_kind: 'member' | 'group'; target_id: string }>()
    for (const rule of rules.results) {
      let matches = false
      try {
        const filter = await compileContactFilter(env.DB, ws, JSON.parse(rule.condition))
        matches = !!await env.DB.prepare(`SELECT 1 FROM contacts c WHERE c.workspace_id=? AND c.id=? AND ${filter.sql}`).bind(ws, conversation.contact_id, ...filter.values).first()
      } catch { matches = false } // regra que aponta para tag ou campo apagado não casa
      if (!matches) continue
      const candidates = rule.target_kind === 'member' ? [rule.target_id].filter(id => team.includes(id))
        : (await env.DB.prepare('SELECT member_id FROM inbox_group_members WHERE group_id=?').bind(rule.target_id).all<{ member_id: string }>()).results.map(r => r.member_id).filter(id => team.includes(id))
      chosen = await leastLoaded(env, ws, candidates, settings.assign_limit)
      if (chosen) break
    }
  }
  chosen ??= await leastLoaded(env, ws, team, settings.assign_limit)
  if (!chosen) return null
  const updated = await env.DB.prepare('UPDATE conversations SET assignee_id=? WHERE workspace_id=? AND id=? AND assignee_id IS NULL RETURNING id').bind(chosen, ws, conversationId).first()
  return updated ? chosen : null
}
