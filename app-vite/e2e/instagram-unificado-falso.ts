import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { ENGINE } from './helpers'
import { APP_ID, webhookDoAppFalso } from './meta-webhook-app-falso'

/** Graph API falsa do login unificado: só HTTP local. Responde a conta, a assinatura, o perfil de quem escreve, o envio de DM (`mensagens`), as publicações e os stories
 * (`posts`, `stories`), as respostas a comentário (`respostas`) e a lista de permissões do token (`/me/permissions`, no formato real do token do login unificado).
 * `/me` e `/me/assigned_instagram_accounts` dão 400 e ficam em `proibidas`. Os interruptores de `estado` mudam o que o token "tem" na Meta falsa.
 * Rotas que a conexão usa além da conta: `/me/accounts` (a Página ligada ao Instagram, com o token DA PÁGINA), `POST /<página>/subscribed_apps` (inscrição
 * da Página, em `paginas`) e o webhook do app (`meta-webhook-app-falso.ts`: `verificacoes`, `webhookDoApp()` e `webhookApp.outroSistema`). */
export { APP_ID }
export const PAGINA_ID = '9000000000000001'

export async function subirInstagramUnificadoFalso(port: number, account: string, username = 'unificado_local', pessoa = 'Pessoa de teste') {
  const tokenDaPagina = `PAGINA-${account}`
  /** Inscrições da Página (POST /<página>/subscribed_apps). */
  const paginas: { authorization: string | undefined; campos: string }[] = []
  const webhookApp = webhookDoAppFalso()
  const chamadas: { metodo: string; path: string; authorization: string | undefined }[] = []
  const proibidas: string[] = []
  const mensagens: { path: string; authorization: string | undefined; body: Record<string, any> }[] = []
  const perfis: { path: string; authorization: string | undefined }[] = []
  const respostas: { path: string; authorization: string | undefined; body: Record<string, any> }[] = []
  const posts = [{ id: '990001', caption: 'Guia para organizar seus estudos', media_type: 'IMAGE', timestamp: new Date(Date.now() - 60_000).toISOString(), permalink: 'https://example.com/publicacao' }]
  const stories = [{ id: '770001', caption: 'Story de hoje: bastidores do lançamento', media_type: 'IMAGE', timestamp: new Date(Date.now() - 3_600_000).toISOString() }]
  /** O que o token "tem" na Meta falsa: sem `mensagens` ou `comentarios` a leitura dá 403 code 10 e a permissão sai de `/me/permissions`; `tokenVencido` dá 401 code 190; `permissoes: false` tira a lista (a conferência cai na prova por leitura). */
  const estado = { mensagens: true, comentarios: true, tokenVencido: false, permissoes: true }
  const erro = (status: number, code: number) => ({ status, body: { error: { message: 'falso', type: 'OAuthException', code } } })
  const server = createServer((req, res) => {
    const pedaco: Buffer[] = []
    req.on('data', c => pedaco.push(c))
    req.on('end', () => {
      const url = new URL(req.url!, 'http://localhost')
      const reply = (body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      chamadas.push({ metodo: req.method ?? 'GET', path: url.pathname + url.search, authorization: req.headers.authorization })
      if (webhookApp.trata(req, url, Buffer.concat(pedaco).toString(), reply)) return
      if (estado.tokenVencido) return reply(erro(401, 190).body, 401)
      // A Página ligada a este Instagram, com o token dela (usado na hora para inscrever a Página; nunca guardado).
      if (req.method === 'GET' && url.pathname === '/v26.0/me/accounts') return reply({ data: [{ id: PAGINA_ID, name: 'Página de teste', access_token: tokenDaPagina, instagram_business_account: { id: account } }] })
      if (req.method === 'POST' && url.pathname === `/v26.0/${PAGINA_ID}/subscribed_apps`) {
        if (req.headers.authorization !== `Bearer ${tokenDaPagina}`) return reply(erro(400, 190).body, 400)
        paginas.push({ authorization: req.headers.authorization, campos: url.searchParams.get('subscribed_fields') ?? '' })
        return reply({ success: true })
      }
      if (req.method === 'GET' && url.pathname.endsWith('/me/permissions')) {
        if (!estado.permissoes) return reply(erro(400, 100).body, 400)
        const concedida = (permission: string, ligada = true) => ({ permission, status: ligada ? 'granted' : 'declined' })
        return reply({ data: [concedida('instagram_basic'), concedida('instagram_manage_comments', estado.comentarios), concedida('instagram_manage_insights'), concedida('instagram_content_publish'),
          concedida('instagram_manage_messages', estado.mensagens), concedida('instagram_manage_events'), concedida('public_profile')] })
      }
      if (/\/me(\/|$)/.test(url.pathname)) { proibidas.push(url.pathname); return reply({ error: { message: 'falso: /me não vale no login unificado', type: 'OAuthException', code: 100 } }, 400) }
      if (req.method === 'GET' && url.pathname.endsWith(`/${account}/conversations`)) return estado.mensagens ? reply({ data: [] }) : reply(erro(403, 10).body, 403)
      if (req.method === 'GET' && url.pathname.endsWith('/comments')) return estado.comentarios ? reply({ data: [] }) : reply(erro(403, 10).body, 403)
      if (req.method === 'GET' && url.pathname.endsWith(`/${account}/stories`)) return reply({ data: stories })
      if (req.method === 'GET' && url.pathname.endsWith(`/${account}/media`)) return reply(url.searchParams.has('after') ? { data: posts } : {
        data: [{ id: '990002', caption: 'Outra publicação recente', media_type: 'IMAGE', timestamp: new Date().toISOString() }],
        paging: { next: 'http://localhost/nao-seguir', cursors: { after: 'publicacoes-antigas' } },
      })
      if (req.method === 'POST' && url.pathname.endsWith('/replies')) {
        const body = pedaco.length ? JSON.parse(Buffer.concat(pedaco).toString()) : {}
        respostas.push({ path: url.pathname, authorization: req.headers.authorization, body })
        return reply({ id: `publica.unificado.${respostas.length}` })
      }
      if (req.method === 'POST' && url.pathname.endsWith(`/${account}/messages`)) {
        const body = pedaco.length ? JSON.parse(Buffer.concat(pedaco).toString()) : {}
        mensagens.push({ path: url.pathname, authorization: req.headers.authorization, body })
        return reply({ recipient_id: body.recipient?.id, message_id: `mid.unificado.${mensagens.length}` })
      }
      // Perfil de quem escreve (User Profile API): /<IGSID>?fields=name,username,...
      if (req.method === 'GET' && /\/v26\.0\/\d+$/.test(url.pathname) && (url.searchParams.get('fields') ?? '').startsWith('name,')) {
        perfis.push({ path: url.pathname + url.search, authorization: req.headers.authorization })
        return reply({ name: pessoa, username: 'pessoa_unificada' })
      }
      if (req.method === 'POST' && url.pathname.endsWith(`/${account}/subscribed_apps`)) return reply({ success: true })
      if (req.method === 'GET' && url.pathname.endsWith(`/${account}`) && url.searchParams.get('fields') === 'id,username') return reply({ id: account, username })
      reply({ error: { message: 'falso: caminho desconhecido', type: 'OAuthException', code: 100 } }, 400)
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  /** Entrega assinada pela rota compartilhada do app da Meta (`/api/webhooks/meta`), como a Meta faria: HMAC-SHA256 do corpo com a chave do app. */
  const entregar = (chave: string, messaging: Record<string, unknown>) => {
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: account, time: Math.floor(Date.now() / 1000), messaging: [messaging] }] })
    return fetch(`${ENGINE}/api/webhooks/meta`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', chave).update(body).digest('hex')}` }, body })
  }
  const receber = (chave: string, igsid: string, mid: string, text: string) =>
    entregar(chave, { sender: { id: igsid }, recipient: { id: account }, timestamp: Date.now(), message: { mid, text } })
  /** Comentário em publicação, como a Meta entrega no login unificado: `value.comment_id` (no login do Instagram vinha `id`). */
  const comentar = (chave: string, igsid: string, commentId: string, text: string, post = '990001') => {
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: account, time: Math.floor(Date.now() / 1000), changes: [{ field: 'comments', value: { comment_id: commentId, from: { id: igsid, username: 'pessoa_unificada' }, media: { id: post }, text, timestamp: new Date().toISOString() } }] }] })
    return fetch(`${ENGINE}/api/webhooks/meta`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', chave).update(body).digest('hex')}` }, body })
  }
  return { chamadas, proibidas, mensagens, perfis, respostas, posts, stories, estado, username, paginas, tokenDaPagina, verificacoes: webhookApp.verificacoes, webhookDoApp: webhookApp.atual, webhookApp: webhookApp.estado, entregar, receber, comentar, fechar: () => new Promise<void>(resolve => server.close(() => resolve())) }
}
