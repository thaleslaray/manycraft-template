import type { IncomingMessage } from 'node:http'
import { ENGINE } from './helpers'

export const APP_ID = '1000000000000001'

/** Webhook do app da Meta falso (graph-api/webhooks, `/{app-id}/subscriptions`), dividido pelas Graphs falsas do Instagram.
 * `GET /app?fields=id` dá o id do app ao token da conta; a lista e a assinatura só aceitam o token do app `<app>|<chave>`.
 * Como a Meta, assinar confere o callback na hora: GET com hub.challenge na rota real do motor (mesmo caminho do callback); sem o desafio de volta, erro 2200.
 * `outroSistema` faz o tópico instagram já apontar para outro sistema (o motor não troca e cai no passo manual). */
export function webhookDoAppFalso() {
  let atual: { callback: string; verifyToken: string; campos: string[]; authorization: string | undefined } | undefined
  /** Conferências de callback que a "Meta" fez ao assinar: status do GET no motor e se o desafio voltou. */
  const verificacoes: { callback: string; status: number; ok: boolean }[] = []
  const estado = { outroSistema: undefined as string | undefined }
  /** Responde as rotas do webhook do app; devolve false quando a rota não é dele. */
  function trata(req: IncomingMessage, url: URL, corpo: string, reply: (body: unknown, status?: number) => void): boolean {
    const erro = (status: number, code: number, message = 'falso') => reply({ error: { message, type: 'OAuthException', code } }, status)
    if (req.method === 'GET' && url.pathname === '/v26.0/app') { reply({ id: APP_ID, name: 'App de teste', link: `https://www.facebook.com/games/?app_id=${APP_ID}` }); return true }
    if (url.pathname !== `/v26.0/${APP_ID}/subscriptions`) return false
    // O token do usuário do sistema não lista nem assina: só o token do app.
    if (!req.headers.authorization?.startsWith(`Bearer ${APP_ID}|`)) { erro(400, 190); return true }
    if (req.method === 'GET') {
      const visto = estado.outroSistema ? { callback: estado.outroSistema, campos: ['messages'] } : atual
      reply({ data: visto ? [{ object: 'instagram', callback_url: visto.callback, active: true, fields: visto.campos.map(name => ({ name, version: 'v26.0' })) }] : [] })
      return true
    }
    const form = new URLSearchParams(corpo)
    const callback = form.get('callback_url') ?? '', verifyToken = form.get('verify_token') ?? ''
    if (req.method !== 'POST' || form.get('object') !== 'instagram' || !callback || !verifyToken) { erro(400, 100); return true }
    const desafio = String(Date.now())
    void fetch(`${ENGINE}${new URL(callback).pathname}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${desafio}`)
      .then(async r => ({ status: r.status, ok: r.status === 200 && await r.text() === desafio }), () => ({ status: 0, ok: false }))
      .then(({ status, ok }) => {
        verificacoes.push({ callback, status, ok })
        if (!ok) return erro(400, 2200, `(#2200) callback verification failed: HTTP Status Code = ${status}`)
        atual = { callback, verifyToken, campos: (form.get('fields') ?? '').split(',').filter(Boolean), authorization: req.headers.authorization }
        reply({ success: true })
      })
    return true
  }
  return { trata, verificacoes, estado, atual: () => atual }
}
