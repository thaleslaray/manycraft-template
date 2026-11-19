import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { json } from './security'
import { enabledSchema } from './schemas/enabled'

/** Sessão do Pixel: 28 dias a partir do clique. */
export const PIXEL_TTL_MS = 28 * 86_400_000
const enc = new TextEncoder()
async function sign(env: Pick<Env, 'BETTER_AUTH_SECRET'>, data: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`pixel:${env.BETTER_AUTH_SECRET ?? 'dev'}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')
}
/** mcp_token = espaço.contato.validade.assinatura (sem segredo à mostra; só o motor valida). */
export async function pixelToken(env: Pick<Env, 'BETTER_AUTH_SECRET'>, workspace: string, contact: string, now = Date.now()) {
  const data = `${workspace}.${contact}.${(now + PIXEL_TTL_MS).toString(36)}`
  return `${data}.${await sign(env, data)}`
}
async function readToken(env: Pick<Env, 'BETTER_AUTH_SECRET'>, token: string, now = Date.now()) {
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [workspace, contact, expires, signature] = parts as [string, string, string, string]
  if (parseInt(expires, 36) < now || signature !== await sign(env, `${workspace}.${contact}.${expires}`)) return null
  return { workspace, contact }
}
/** Acrescenta o mcp_token ao link quando o espaço ligou o Pixel. */
export async function withPixelToken(env: Env, workspace: string, contact: string, target: string) {
  const on = await env.DB.prepare("SELECT w.pixel_enabled FROM workspaces w WHERE w.id=? AND EXISTS (SELECT 1 FROM contacts WHERE workspace_id=w.id AND id=? AND status<>'deleted')").bind(workspace, contact).first<number>('pixel_enabled')
  if (!on) return target
  try { const url = new URL(target); url.searchParams.set('mcp_token', await pixelToken(env, workspace, contact)); return url.href } catch { return target }
}

const script = `(function(){var k='mcp_token',p=new URLSearchParams(location.search).get(k);
if(p){document.cookie=k+'='+encodeURIComponent(p)+';path=/;max-age=${PIXEL_TTL_MS / 1000};SameSite=Lax';}
function t(){var m=document.cookie.match(/(?:^|; )mcp_token=([^;]+)/);return m?decodeURIComponent(m[1]):null}
var base=(document.currentScript&&new URL(document.currentScript.src).origin)||'';
function send(b){var x=t();if(!x)return Promise.resolve(false);b.token=x;return fetch(base+'/api/pixel/event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b),keepalive:true}).then(function(r){return r.ok})}
window.MC_PIXEL={fireLogConversionEvent:function(n){return send({kind:'conversion',name:String(n||'')})},fireLogMoneyEvent:function(a,c){return send({kind:'money',amount:Number(a),currency:String(c||'BRL')})}};})();`

/** Rotas públicas: o script e o recebimento de eventos (qualquer site pode chamar; o token assinado escolhe o contato). */
export const pixelPublic = new Hono<{ Bindings: Env }>()
pixelPublic.get('/pixel.js', c => c.body(script, 200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' }))
pixelPublic.options('/pixel/event', c => c.body(null, 204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' }))
pixelPublic.post('/pixel/event', async c => {
  c.header('access-control-allow-origin', '*')
  const input = z.object({ token: z.string().max(400), kind: z.enum(['conversion', 'money']), name: z.string().max(100).optional(),
    amount: z.number().finite().nonnegative().optional(), currency: z.string().regex(/^[A-Za-z]{3}$/).optional() }).strict().parse(await json(c.req.raw))
  const who = await readToken(c.env, input.token)
  if (!who) throw new HTTPException(401, { message: 'Token do Pixel inválido ou vencido.' })
  if (input.kind === 'money' && input.amount === undefined) throw new HTTPException(400, { message: 'Informe o valor.' })
  const r = await c.env.DB.prepare(`INSERT INTO pixel_events(id,workspace_id,contact_id,kind,name,amount,currency,created_at) SELECT ?,?,?,?,?,?,?,?
    WHERE EXISTS (SELECT 1 FROM workspaces WHERE id=? AND pixel_enabled=1) AND EXISTS (SELECT 1 FROM contacts WHERE workspace_id=? AND id=? AND status<>'deleted')`)
    .bind(crypto.randomUUID(), who.workspace, who.contact, input.kind, input.name ?? null, input.kind === 'money' ? input.amount : null,
      input.kind === 'money' ? (input.currency ?? 'BRL').toUpperCase() : null, Date.now(), who.workspace, who.workspace, who.contact).run()
  if (!r.meta.changes) throw new HTTPException(404, { message: 'Pixel desligado ou contato inexistente.' })
  return c.json({ ok: true })
})

/** Painel: ligar o Pixel e ver os últimos eventos. */
export const pixelPanel = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
pixelPanel.get('/pixel', async c => {
  authorize(c.var.principal, 'automation:read')
  const ws = c.var.principal.workspaceId
  const [enabled, events] = await Promise.all([
    c.env.DB.prepare('SELECT pixel_enabled FROM workspaces WHERE id=?').bind(ws).first<number>('pixel_enabled'),
    c.env.DB.prepare(`SELECT e.id,e.kind,e.name,e.amount,e.currency,e.created_at,e.contact_id,trim(coalesce(k.first_name,'')||' '||coalesce(k.last_name,'')) AS contact_name
      FROM pixel_events e LEFT JOIN contacts k ON k.workspace_id=e.workspace_id AND k.id=e.contact_id WHERE e.workspace_id=? ORDER BY e.created_at DESC LIMIT 100`).bind(ws).all(),
  ])
  return c.json({ enabled: !!enabled, events: events.results })
})
pixelPanel.put('/pixel', async c => {
  authorize(c.var.principal, 'edit')
  const { enabled } = enabledSchema.parse(await json(c.req.raw))
  await c.env.DB.prepare('UPDATE workspaces SET pixel_enabled=? WHERE id=?').bind(enabled ? 1 : 0, c.var.principal.workspaceId).run()
  return c.json({ enabled })
})
