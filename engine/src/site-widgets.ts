import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { json } from './security'
import { ExternalRequestError } from './flow/external-url'
import { destination } from './flow/external-request'

/** Widget de site: o script público desenha um botão flutuante que abre a conversa (link de referência do gatilho). */
export const siteWidgetPublic = new Hono<{ Bindings: Env }>()
siteWidgetPublic.get('/site-widget/:file', async c => {
  const id = c.req.param('file').replace(/\.js$/, '')
  const w = await c.env.DB.prepare('SELECT label,target_url FROM site_widgets WHERE id=?').bind(id).first<{ label: string; target_url: string }>()
  if (!w) return c.body('/* widget não encontrado */', 404, { 'content-type': 'application/javascript' })
  const js = `(function(){if(window.__siteWidget_${id.replace(/-/g, '')})return;window.__siteWidget_${id.replace(/-/g, '')}=1;
var a=document.createElement('a');a.href=${JSON.stringify(w.target_url)};a.target='_blank';a.rel='noopener';a.textContent=${JSON.stringify(w.label)};
a.setAttribute('data-site-widget',${JSON.stringify(id)});a.style.cssText='position:fixed;right:20px;bottom:20px;z-index:2147483000;padding:12px 18px;border-radius:999px;background:#1f6feb;color:#fff;font:600 15px system-ui,sans-serif;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.2)';
(document.body?Promise.resolve():new Promise(function(r){document.addEventListener('DOMContentLoaded',r)})).then(function(){document.body.appendChild(a)})})();`
  return c.body(js, 200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' })
})

export const siteWidgets = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
export const siteWidgetCreateSchema = z.object({ label: z.string().trim().min(1).max(60), target_url: z.url({ protocol: /^https$/ }).max(2000) }).strict()
export const siteWidgetDiagnoseSchema = z.object({ page_url: z.url() }).strict()
const id = z.string().min(1).max(128)
siteWidgets.get('/site-widgets', async c => {
  authorize(c.var.principal, 'automation:read')
  return c.json({ items: (await c.env.DB.prepare('SELECT id,label,target_url,created_at FROM site_widgets WHERE workspace_id=? ORDER BY created_at').bind(c.var.principal.workspaceId).all()).results })
})
siteWidgets.post('/site-widgets', async c => {
  authorize(c.var.principal, 'edit')
  const input = siteWidgetCreateSchema.parse(await json(c.req.raw))
  const key = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO site_widgets (id,workspace_id,label,target_url,created_at) VALUES (?,?,?,?,?)').bind(key, c.var.principal.workspaceId, input.label, input.target_url, Date.now()).run()
  return c.json({ id: key, ...input }, 201)
})
siteWidgets.delete('/site-widgets/:id', async c => {
  authorize(c.var.principal, 'edit')
  const r = await c.env.DB.prepare('DELETE FROM site_widgets WHERE workspace_id=? AND id=?').bind(c.var.principal.workspaceId, id.parse(c.req.param('id'))).run()
  if (!r.meta.changes) throw new HTTPException(404, { message: 'Widget não encontrado.' })
  return c.body(null, 204)
})
const MAX_REDIRECTS = 5
const MAX_PAGE_CHARS = 2_000_000
/** Segue o redirecionamento à mão, até MAX_REDIRECTS saltos: cada destino passa pela mesma regra das requisições externas. */
async function openPage(first: URL, signal: AbortSignal): Promise<Response> {
  let target = first
  for (let hop = 0; ; hop++) {
    const response = await fetch(target, { redirect: 'manual', signal })
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    if (location === null) return response
    await response.body?.cancel()
    if (hop === MAX_REDIRECTS) throw new ExternalRequestError('redirect', `A página redireciona mais de ${MAX_REDIRECTS} vezes.`)
    let next: URL
    try { next = new URL(location, target) } catch { throw new ExternalRequestError('redirect', 'A página redireciona para um endereço inválido.') }
    try { target = destination(next.href) }
    catch (error) { throw new ExternalRequestError('redirect', `A página redireciona para um endereço que não pode ser aberto. ${error instanceof Error ? error.message : ''}`.trim()) }
  }
}
/** Só o começo da página: o resto é cancelado, e uma resposta sem fim não prende nem estoura a memória do diagnóstico. */
async function readStart(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let html = ''
  while (html.length < MAX_PAGE_CHARS) {
    const { done, value } = await reader.read()
    if (done) return html
    html += decoder.decode(value, { stream: true })
  }
  await reader.cancel()
  return html.slice(0, MAX_PAGE_CHARS)
}
/** Diagnóstico: a página usa HTTPS, carrega o script deste widget (uma vez só) e o domínio responde. */
siteWidgets.post('/site-widgets/:id/diagnose', async c => {
  authorize(c.var.principal, 'automation:read')
  const widget = id.parse(c.req.param('id'))
  if (!await c.env.DB.prepare('SELECT 1 FROM site_widgets WHERE workspace_id=? AND id=?').bind(c.var.principal.workspaceId, widget).first()) throw new HTTPException(404, { message: 'Widget não encontrado.' })
  const { page_url } = siteWidgetDiagnoseSchema.parse(await json(c.req.raw))
  const url = new URL(page_url)
  const checks: { check: string; ok: boolean; detail: string }[] = []
  checks.push({ check: 'https', ok: url.protocol === 'https:', detail: url.protocol === 'https:' ? 'A página usa HTTPS.' : 'Use HTTPS: navegadores bloqueiam o widget em página sem HTTPS.' })
  let first: URL
  try { first = destination(page_url) }
  catch (error) { return c.json({ ok: false, checks: [...checks, { check: 'domain', ok: false, detail: error instanceof ExternalRequestError ? error.message : 'Endereço inválido.' }] }) }
  let html = ''
  try {
    const r = await openPage(first, AbortSignal.timeout(10_000))
    html = await readStart(r)
    checks.push({ check: 'domain', ok: r.ok, detail: r.ok ? 'O domínio respondeu.' : `O site respondeu ${r.status}.` })
  } catch (error) { checks.push({ check: 'domain', ok: false, detail: error instanceof ExternalRequestError ? error.message : 'Não foi possível abrir a página.' }) }
  const found = html.split(`/api/site-widget/${widget}.js`).length - 1
  checks.push({ check: 'script', ok: found >= 1, detail: found ? 'O script do widget está na página.' : 'O script não foi encontrado no HTML da página.' })
  if (found > 1) checks.push({ check: 'duplicate', ok: false, detail: `O script aparece ${found} vezes; deixe só uma.` })
  return c.json({ ok: checks.every(x => x.ok), checks })
})
