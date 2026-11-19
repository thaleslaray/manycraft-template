import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { ENGINE } from './helpers'
import { webhookDoAppFalso } from './meta-webhook-app-falso'

/** Apenas HTTP local, nas rotas do login unificado: confere a conta (`/<conta>?fields=id,username`), lista as permissões, assina o webhook do app
 * (`meta-webhook-app-falso.ts`, com o handshake real no motor) e captura os efeitos de comentário. */
export async function subirInstagramFalso(port: number, account: string) {
  const chamadas: { path: string; body: Record<string, any> }[] = []
  const posts = [{ id: '990001', caption: 'Guia para organizar seus estudos', media_type: 'IMAGE', timestamp: new Date(Date.now() - 60_000).toISOString(), permalink: 'https://example.com/publicacao' }]
  const stories = [{ id: '770001', caption: 'Story de hoje: bastidores do lançamento', media_type: 'IMAGE', timestamp: new Date(Date.now() - 3_600_000).toISOString() },
    { id: '770002', caption: 'Story: novidade da semana', media_type: 'IMAGE', timestamp: new Date(Date.now() - 600_000).toISOString() }]
  /** Interruptores da conferência de "Atualizar conexão": o que o token "tem" na Meta falsa. */
  const estado = { mensagens: true, comentarios: true, tokenVencido: false }
  const erro = (status: number, code: number) => ({ status, body: { error: { message: 'falso', type: 'OAuthException', code } } })
  const webhookApp = webhookDoAppFalso()
  const PAGINA_ID = '9000000000000002', tokenDaPagina = `PAGINA-${account}`
  /** Campos pedidos em cada inscrição da Página. */
  const paginas: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url!, 'http://localhost')
      const reply = (body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      const negar = (e: { status: number; body: unknown }) => reply(e.body, e.status)
      if (webhookApp.trata(req, url, Buffer.concat(chunks).toString(), reply)) return
      if (estado.tokenVencido && (url.pathname.endsWith(`/${account}`) || url.pathname.endsWith('/me/permissions'))) return negar(erro(401, 190))
      if (req.method === 'GET' && url.pathname.endsWith('/me/permissions')) return reply({ data: [
        { permission: 'instagram_manage_messages', status: estado.mensagens ? 'granted' : 'declined' }, { permission: 'instagram_manage_comments', status: estado.comentarios ? 'granted' : 'declined' },
        ...['pages_show_list', 'pages_manage_metadata', 'pages_messaging'].map(permission => ({ permission, status: 'granted' }))] })
      // A Página ligada a este Instagram, com o token dela; inscrevê-la (POST /<página>/subscribed_apps) só vale com esse token.
      if (req.method === 'GET' && url.pathname.endsWith('/me/accounts')) return reply({ data: [{ id: PAGINA_ID, name: 'Página de teste', access_token: tokenDaPagina, instagram_business_account: { id: account } }] })
      if (req.method === 'POST' && url.pathname.endsWith(`/${PAGINA_ID}/subscribed_apps`)) {
        if (req.headers.authorization !== `Bearer ${tokenDaPagina}`) return negar(erro(400, 190))
        paginas.push(url.searchParams.get('subscribed_fields') ?? '')
        return reply({ success: true })
      }
      if (req.method === 'GET' && url.pathname.endsWith('/conversations')) return estado.mensagens ? reply({ data: [] }) : negar(erro(403, 10))
      if (req.method === 'GET' && url.pathname.endsWith('/comments')) return estado.comentarios ? reply({ data: [] }) : negar(erro(403, 10))
      if (req.method === 'GET' && url.pathname.endsWith(`/${account}`)) return reply({ id: account, username: 'estudos_local' })
      if (url.pathname.endsWith('/stories')) return reply({ data: stories })
      if (url.pathname.endsWith('/media')) return reply(url.searchParams.has('after') ? { data: posts } : {
        data: [{ id: '990002', caption: 'Outra publicação recente', media_type: 'IMAGE', timestamp: new Date().toISOString() }],
        paging: { next: 'http://localhost/unused', cursors: { after: 'older-posts' } },
      })
      if (req.method === 'GET') return reply({ name: 'Pessoa de teste', username: 'pessoa_local' })
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      chamadas.push({ path: url.pathname, body })
      reply(url.pathname.endsWith('/messages') ? { message_id: `private-${chamadas.length}` } : { id: `public-${chamadas.length}`, success: true })
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  const entregar = (connection: string, message: Record<string, unknown>) => {
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: account, time: Math.floor(Date.now() / 1000), messaging: [{ sender: { id: '190001' }, recipient: { id: account }, timestamp: Date.now(), message }] }] })
    return fetch(`${ENGINE}/api/hooks/${connection}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'e2e-app-secret').update(body).digest('hex')}` }, body })
  }
  return { chamadas, estado, posts, stories, verificacoes: webhookApp.verificacoes, paginas, fechar: () => new Promise<void>(resolve => server.close(() => resolve())),
    /** Resposta a um story: mensagem comum com `reply_to.story`. */
    responderStory: (connection: string, mid: string, text: string, story = '770001') => entregar(connection, { mid, text, reply_to: { story: { id: story, url: 'https://example.com/story.jpg' } } }),
    /** Menção da conta no story de outra pessoa: anexo `story_mention`, sem texto. */
    mencionarStory: (connection: string, mid: string) => entregar(connection, { mid, attachments: [{ type: 'story_mention', payload: { url: 'https://example.com/mencao.jpg' } }] }),
    async comentar(connection: string, id: string, text: string, post = '990001') {
      const body = JSON.stringify({ object: 'instagram', entry: [{ id: account, time: Math.floor(Date.now() / 1000), changes: [{ field: 'comments', value: { id, from: { id: '190001', username: 'pessoa_local' }, media: { id: post }, text, timestamp: new Date().toISOString() } }] }] })
      return fetch(`${ENGINE}/api/hooks/${connection}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'e2e-app-secret').update(body).digest('hex')}` }, body })
    },
  }
}
