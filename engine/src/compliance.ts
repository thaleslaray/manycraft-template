import { Hono } from 'hono'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { connectionStateLabels, effectiveStateSql, type ConnectionState } from './channels/core/connection-state'

type Issue = { severity: 'high' | 'medium' | 'low'; kind: string; title: string; detail: string }

/**
 * Monitoramento de conformidade: sinais de risco do espaço em uma lista só — conexões com erro, modelos de mensagem rejeitados
 * ou pausados, taxa de descadastro e de falhas de envio dos últimos 7 dias. Leitura; nada é alterado.
 */
export const compliance = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
compliance.get('/compliance', async c => {
  authorize(c.var.principal, 'team')
  const ws = c.var.principal.workspaceId, since = Date.now() - 7 * 86_400_000
  const [channels, templates, contacts, events] = await Promise.all([
    // Estado efetivo (connection-state.ts): antes só `status` contava, e uma conexão com erro, restrita ou com o número fora do aparelho ficava de fora.
    c.env.DB.prepare(`SELECT id,coalesce(display_name,type) AS name,${effectiveStateSql()} AS status FROM channels WHERE workspace_id=? AND archived_at IS NULL AND ${effectiveStateSql()} IN ('error','restricted','disconnected')`).bind(ws).all<{ name: string; status: ConnectionState }>(),
    c.env.DB.prepare("SELECT name_human,status,rejection_reason FROM message_templates WHERE workspace_id=? AND status IN ('rejected','paused','disabled')").bind(ws).all<{ name_human: string; status: string; rejection_reason: string | null }>(),
    c.env.DB.prepare("SELECT count(*) AS total,sum(CASE WHEN unsubscribed_at>=? THEN 1 ELSE 0 END) AS left_week FROM contacts WHERE workspace_id=? AND status<>'deleted'").bind(since, ws).first<{ total: number; left_week: number | null }>(),
    c.env.DB.prepare("SELECT sum(type='sent') AS sent,sum(type='failed') AS failed FROM node_events WHERE workspace_id=? AND created_at>=?").bind(ws, since).first<{ sent: number | null; failed: number | null }>(),
  ])
  const issues: Issue[] = []
  for (const ch of channels.results) issues.push({ severity: 'high', kind: 'connection', title: `Conexão ${ch.name} ${ch.status === 'disconnected' ? 'desconectada' : connectionStateLabels[ch.status]}`, detail: 'Automações e transmissões desta conexão não entregam até reconectar.' })
  for (const t of templates.results) issues.push({ severity: t.status === 'rejected' ? 'medium' : 'high', kind: 'template',
    title: `Modelo "${t.name_human}" ${t.status === 'rejected' ? 'rejeitado' : t.status === 'paused' ? 'pausado pela plataforma' : 'desativado'}`,
    detail: t.rejection_reason ?? (t.status === 'paused' ? 'Qualidade baixa: reduza a frequência ou revise o conteúdo.' : 'Revise o conteúdo e envie de novo.') })
  const total = contacts?.total ?? 0, left = contacts?.left_week ?? 0
  const optOutRate = total ? left / total : 0
  if (left >= 5 && optOutRate >= 0.02) issues.push({ severity: optOutRate >= 0.05 ? 'high' : 'medium', kind: 'opt_out', title: `${(optOutRate * 100).toFixed(1)}% dos contatos se descadastraram em 7 dias`, detail: 'Descadastro alto costuma indicar mensagens demais ou fora do que a pessoa pediu.' })
  const sent = events?.sent ?? 0, failed = events?.failed ?? 0
  const failRate = sent + failed ? failed / (sent + failed) : 0
  if (failed >= 5 && failRate >= 0.05) issues.push({ severity: failRate >= 0.2 ? 'high' : 'medium', kind: 'delivery', title: `${(failRate * 100).toFixed(1)}% dos envios falharam em 7 dias`, detail: 'Veja os erros em Configurações › Registros e nas métricas de cada automação.' })
  const order = { high: 0, medium: 1, low: 2 }
  issues.sort((a, b) => order[a.severity] - order[b.severity])
  return c.json({ status: issues.some(i => i.severity === 'high') ? 'at_risk' : issues.length ? 'attention' : 'ok', issues,
    metrics: { contacts: total, unsubscribed_7d: left, sent_7d: sent, failed_7d: failed } })
})
