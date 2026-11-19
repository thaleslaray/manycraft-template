import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { NonRetryableError } from 'cloudflare:workflows'
import type { Env } from '../env'
import { withPixelToken } from '../pixel'
import { clickableRunStatuses } from './run-state'
import { CONNECTION_RESTORED_EVENT } from './connection-wait'

/** Tracked address for a link button that also continues the flow: opening it resumes the waiting run. */
export function flowLinkUrl(env: Pick<Env, 'PUBLIC_BASE_URL' | 'BETTER_AUTH_URL'>, token: string): string {
  let base: URL
  try { base = new URL(env.PUBLIC_BASE_URL ?? env.BETTER_AUTH_URL ?? '') } catch { throw new NonRetryableError('Configure um endereço público para botões de link com saída.') }
  if (!['http:', 'https:'].includes(base.protocol)) throw new NonRetryableError('Configure um endereço público para botões de link com saída.')
  return new URL(`/api/flow-public/click/${token}`, base).href
}

// Mounted before workspace authentication: the random token selects only its stored destination.
export const publicFlowRoutes = new Hono<{ Bindings: Env }>()
publicFlowRoutes.get('/click/:token', async c => {
  const token = c.req.param('token')
  if (!/^[a-f0-9]{24}$/.test(token)) throw new HTTPException(404)
  const row = await c.env.DB.prepare(`SELECT r.workspace_id,r.contact_id,b.run_id,b.step_index,b.node_id,b.expires_at,b.target_url,r.status,r.wait_reason,r.current_node_id
    FROM button_tokens b JOIN flow_runs r ON r.workspace_id=b.workspace_id AND r.id=b.run_id
    WHERE b.token=? AND b.target_url IS NOT NULL`).bind(token)
    .first<{ workspace_id: string; contact_id: string; run_id: string; step_index: number; node_id: string; expires_at: number; target_url: string; status: string; wait_reason: string | null; current_node_id: string }>()
  if (!row) throw new HTTPException(404)
  // The address always opens; the run continues only while it still waits on this very step, and only once.
  // Waiting for the connection on this step (the button may expire meanwhile): the contact still sees the message, so the click counts and ends the wait.
  const connectionWait = row.status === 'waiting_delay' && row.wait_reason === 'connection'
  const live = (row.expires_at > Date.now() || connectionWait) && row.current_node_id === row.node_id
    && ((clickableRunStatuses as readonly string[]).includes(row.status) || connectionWait)
  if (live && c.env.FLOW_RUN) {
    await c.env.DB.prepare('INSERT INTO flow_clicks (run_id,step_index,token,inbound_event_id) VALUES (?,?,?,?) ON CONFLICT(run_id,step_index) DO NOTHING')
      .bind(row.run_id, row.step_index, token, `link-${token}`).run()
    const receipt = await c.env.DB.prepare('SELECT token,inbound_event_id,delivered_at FROM flow_clicks WHERE run_id=? AND step_index=?')
      .bind(row.run_id, row.step_index).first<{ token: string; inbound_event_id: string; delivered_at: number | null }>()
    if (receipt && receipt.inbound_event_id === `link-${token}` && receipt.delivered_at === null) {
      const instance = await c.env.FLOW_RUN.get(row.run_id)
      await instance.sendEvent({ type: `click_${row.step_index}`, payload: { token } })
      if (connectionWait) await instance.sendEvent({ type: CONNECTION_RESTORED_EVENT, payload: {} })
      await c.env.DB.prepare('UPDATE flow_clicks SET delivered_at=? WHERE run_id=? AND step_index=?').bind(Date.now(), row.run_id, row.step_index).run()
    }
  }
  return c.redirect(await withPixelToken(c.env, row.workspace_id, row.contact_id, row.target_url), 302)
})

/**
 * Webview do fluxo: um passo de mensagem publicado aberto como página (texto, imagens e links), para botões que abrem no navegador
 * do app de conversa. O endereço leva automação e passo; só a versão publicada aparece.
 */
publicFlowRoutes.get('/webview/:automation/:node', async c => {
  const graph = await c.env.DB.prepare(`SELECT a.name,v.graph FROM automations a JOIN automation_versions v ON v.workspace_id=a.workspace_id AND v.id=a.published_version_id
    WHERE a.id=? AND a.deleted_at IS NULL`).bind(c.req.param('automation')).first<{ name: string; graph: string }>()
  const node = graph && (JSON.parse(graph.graph) as { nodes: { id: string; type: string; config: { blocks?: { kind: string; text?: string; url?: string; label?: string; action?: { type: string; url?: string } }[] } }[] }).nodes.find(n => n.id === c.req.param('node'))
  if (!graph || !node || !Array.isArray(node.config.blocks)) throw new HTTPException(404)
  const esc = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
  const safe = (u: string) => /^https?:\/\//.test(u) ? esc(u) : '#'
  const body = node.config.blocks.map(b => b.kind === 'text' ? `<p>${esc(b.text ?? '').replace(/\n/g, '<br>')}</p>`
    : b.kind === 'media' && b.url ? `<img src="${safe(b.url)}" alt="">`
    : b.kind === 'button' && b.action?.type === 'url' && b.action.url ? `<a class="b" href="${safe(b.action.url)}">${esc(b.label ?? 'Abrir')}</a>` : '').join('\n')
  return c.html(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(graph.name)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:0 auto;padding:16px}img{max-width:100%;border-radius:8px}.b{display:block;text-align:center;padding:12px;margin:8px 0;border-radius:8px;background:#222;color:#fff;text-decoration:none}</style></head><body>${body}</body></html>`)
})

/** Link curto do corpo do texto: abre o destino e conta o clique no passo (uma vez por link). */
publicFlowRoutes.get('/l/:token', async c => {
  const token = c.req.param('token')
  if (!/^[a-z0-9]{10}$/.test(token)) throw new HTTPException(404)
  const row = await c.env.DB.prepare('SELECT s.url,s.node_id,s.clicked_at,r.workspace_id,r.contact_id,r.id AS run_id,v.automation_id FROM short_links s JOIN flow_runs r ON r.id=s.run_id JOIN automation_versions v ON v.id=r.automation_version_id WHERE s.token=?')
    .bind(token).first<{ url: string; node_id: string; clicked_at: number | null; workspace_id: string; contact_id: string; run_id: string; automation_id: string }>()
  if (!row) throw new HTTPException(404)
  // Contato apagado: o endereço abre, mas nada é gravado em nome dele.
  const erased = await c.env.DB.prepare("SELECT 1 FROM contacts WHERE workspace_id=? AND id=? AND status='deleted'").bind(row.workspace_id, row.contact_id).first()
  if (!row.clicked_at && !erased) await c.env.DB.batch([
    c.env.DB.prepare('UPDATE short_links SET clicked_at=? WHERE token=? AND clicked_at IS NULL').bind(Date.now(), token),
    c.env.DB.prepare(`INSERT INTO node_events (workspace_id,automation_id,node_id,button_id,contact_id,flow_run_id,type) VALUES (?,?,?,?,?,?,'clicked') ON CONFLICT DO NOTHING`)
      .bind(row.workspace_id, row.automation_id, row.node_id, `link:${token}`, row.contact_id, row.run_id),
  ])
  return c.redirect(await withPixelToken(c.env, row.workspace_id, row.contact_id, row.url), 302)
})

/** Troca cada link http(s) do texto por um link curto deste passo. Sem endereço público configurado, o texto fica como está. */
export async function shortenLinks(env: Pick<Env, 'DB' | 'PUBLIC_BASE_URL' | 'BETTER_AUTH_URL'>, run: { id: string; workspace_id: string }, nodeId: string, text: string): Promise<string> {
  let base: URL
  try { base = new URL(env.PUBLIC_BASE_URL ?? env.BETTER_AUTH_URL ?? '') } catch { return text }
  const urls = [...new Set(text.match(/https?:\/\/[^\s<>"']+/g) ?? [])]
  for (const url of urls) {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(10)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
    await env.DB.prepare('INSERT INTO short_links (token,workspace_id,run_id,node_id,url,created_at) VALUES (?,?,?,?,?,?)').bind(token, run.workspace_id, run.id, nodeId, url, Date.now()).run()
    text = text.split(url).join(new URL(`/api/flow-public/l/${token}`, base).href)
  }
  return text
}
