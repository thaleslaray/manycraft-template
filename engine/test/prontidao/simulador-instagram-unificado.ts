import { env } from 'cloudflare:workers'
import { webhooks } from '../../src/integrations'
import { APP_SECRET } from './canal-whatsapp'
import { SimuladorMensagens, errosMensagens } from './simulador-meta-mensagens'
import { erroMeta } from './simuladores'

/** `/me/permissions` como a Graph devolve para o token de usuário do sistema do app novo (nome e ordem reais, diário B4h). */
export const PERMISSOES_UNIFICADO = ['instagram_basic', 'instagram_manage_comments', 'instagram_manage_insights', 'instagram_content_publish', 'instagram_manage_messages', 'instagram_manage_events', 'public_profile']

/**
 * Instagram API com Login unificado: host graph.facebook.com e token de usuário do sistema (SUAT). Só responde às rotas dessa conexão:
 * `/me` é o usuário do sistema (id e nome, SEM `user_id`), a conta é conferida em `/<IG_ID>?fields=id,username`, `/me/permissions` lista as
 * permissões, `/<IG_ID>/subscribed_apps` assina os campos, `/<comment_id>/replies` responde em público e `/<IG_ID>/messages` com
 * `recipient.comment_id` é a resposta privada. Qualquer outra rota cai nos erros da base; o host graph.instagram.com nem é aceito.
 * Webhook do app (graph-api/webhooks, /{app-id}/subscriptions): `GET /app` dá o id do app ao token do usuário do sistema; a lista e a assinatura
 * só aceitam o token do app `{app-id}|{chave secreta}`. Como a Meta, a assinatura confere o callback na hora (GET com hub.challenge na rota
 * de webhooks real do motor) e recusa com o erro 2200 quando o callback não devolve o desafio.
 */
export class InstagramUnificadoGraph extends SimuladorMensagens {
  /** Respostas privadas a comentários (POST /<IG_ID>/messages com recipient.comment_id). */
  respostasPrivadas: { comentario: string; texto: string; botoes: { titulo: string; url?: string }[]; bruto: unknown }[] = []
  /** Respostas públicas a comentários (POST /<comment_id>/replies). */
  respostasPublicas: { comentario: string; texto: string }[] = []
  /** Assinaturas de webhook pedidas por `subscribed_apps`. */
  assinaturas: string[] = []
  usuarioDoSistema = '122100000000000001'
  appId = '1000000000000001'
  /** Assinatura atual do tópico instagram no app (o que a Meta guarda depois de conferir o callback). */
  webhookDoApp: { callback: string; verifyToken: string; campos: string[] } | undefined
  /** Conferências de callback que a "Meta" fez ao assinar: o que respondeu e se bateu com o desafio. */
  verificacoes: { callback: string; status: number; ok: boolean }[] = []
  constructor(contaId = '17841400000000001') { super({ host: 'graph.facebook.com', contaId, rotuloConta: 'instagram', nome: 'instagram-unificado' }) }

  protected override rota(req: Request, url: URL, corpo: any): Response | undefined | Promise<Response | undefined> {
    const m = url.pathname.match(/^\/v\d+\.\d+\/([^/]+)(?:\/([^/]+))?$/)
    if (!m) return undefined
    const [, alvo, sub] = m
    if (req.method === 'GET' && alvo === 'app' && !sub) return Response.json({ id: this.appId, name: 'App de teste', link: 'https://www.facebook.com/games/?app_id=' + this.appId })
    if (alvo === this.appId && sub === 'subscriptions') return this.assinaturaDoApp(req, corpo)
    if (req.method === 'GET' && alvo === 'me' && !sub) return Response.json({ id: this.usuarioDoSistema, name: 'Usuário do sistema' })
    if (req.method === 'GET' && alvo === 'me' && sub === 'permissions') return Response.json({ data: PERMISSOES_UNIFICADO.map(permission => ({ permission, status: 'granted' })) })
    // O unificado devolve a lista vazia aqui (diário B4h): a conta é conferida pelo ID colado.
    if (req.method === 'GET' && alvo === 'me' && sub === 'assigned_instagram_accounts') return Response.json({ data: [] })
    if (req.method === 'GET' && alvo === this.contaId && !sub) return Response.json({ id: this.contaId, username: 'oficina_horizonte' })
    if (req.method === 'GET' && !sub && alvo !== 'me') return Response.json({ name: 'Pessoa de Teste', username: `usuario_${alvo}`, profile_pic: 'https://scontent.example.com/pic.jpg' })
    if (req.method === 'GET' && alvo !== 'me' && alvo !== this.contaId) return erroMeta(400, 100, 'Unsupported get request. Object does not exist', { error_subcode: 33 })
    if (req.method === 'POST' && alvo === this.contaId && sub === 'subscribed_apps') {
      this.assinaturas.push(url.searchParams.get('subscribed_fields') ?? String(corpo?.subscribed_fields ?? ''))
      return Response.json({ success: true })
    }
    if (req.method === 'POST' && sub === 'replies' && alvo !== this.contaId) {
      if (!corpo?.message) return errosMensagens.parametroInvalido()
      this.respostasPublicas.push({ comentario: alvo, texto: corpo.message })
      return Response.json({ id: `reply_SIM${this.respostasPublicas.length}` })
    }
    const comentario = corpo?.recipient?.comment_id
    if (req.method === 'POST' && alvo === this.contaId && sub === 'messages' && comentario) {
      const p = corpo.message?.attachment?.payload
      this.respostasPrivadas.push({ comentario, texto: corpo.message?.text ?? p?.text ?? '', botoes: (p?.buttons ?? []).map((b: any) => ({ titulo: b.title, url: b.url })), bruto: corpo })
      return Response.json({ recipient_id: '190001', message_id: `m_PRIV${String(this.respostasPrivadas.length).padStart(6, '0')}` })
    }
    return undefined
  }

  protected override tokenAceito(auth: string | null, req: Request, url: URL): boolean {
    // O token do app só vale nas rotas do próprio app.
    if (auth === `${this.appId}|${APP_SECRET}`) return url.pathname.endsWith(`/${this.appId}/subscriptions`)
    return super.tokenAceito(auth, req, url)
  }

  private async assinaturaDoApp(req: Request, corpo: any): Promise<Response> {
    if (req.method === 'GET') return Response.json({ data: this.webhookDoApp ? [{ object: 'instagram', callback_url: this.webhookDoApp.callback, active: true,
      fields: this.webhookDoApp.campos.map(name => ({ name, version: 'v26.0' })) }] : [] })
    if (req.method !== 'POST' || corpo?.object !== 'instagram' || !corpo?.callback_url || !corpo?.verify_token) return errosMensagens.parametroInvalido()
    // A Meta confere o callback antes de gravar: GET com hub.mode, hub.verify_token e hub.challenge, e espera o desafio de volta.
    const callback = new URL(String(corpo.callback_url))
    if (!callback.pathname.endsWith('/api/webhooks/meta')) return erroMeta(400, 2200, '(#2200) callback verification failed: HTTP Status Code = 404; HTTP Message = Not Found')
    const desafio = String(Date.now())
    const resposta = await webhooks.request(`/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(String(corpo.verify_token))}&hub.challenge=${desafio}`, {}, { ...env } as never)
    const ok = resposta.status === 200 && await resposta.text() === desafio
    this.verificacoes.push({ callback: callback.toString(), status: resposta.status, ok })
    if (!ok) return erroMeta(400, 2200, `(#2200) callback verification failed: HTTP Status Code = ${resposta.status}; HTTP Message = ${resposta.statusText || 'Forbidden'}`)
    this.webhookDoApp = { callback: callback.toString(), verifyToken: String(corpo.verify_token), campos: String(corpo.fields ?? '').split(',').filter(Boolean) }
    return Response.json({ success: true })
  }
}
