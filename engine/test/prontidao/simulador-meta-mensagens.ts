/**
 * Base dos simuladores da Graph API de mensagens (Instagram Login e Messenger). Formatos da documentação oficial:
 * Send API (POST /{id}/messages com recipient.id + message.text | quick_replies | attachment template/button) → {recipient_id, message_id};
 * erros {error:{message,type,code,error_subcode,fbtrace_id}}.
 */
import { erroMeta, type Enviada, type Falha, type Simulador } from './simuladores'

/** Erros reais da Graph API em mensagens (Instagram e Messenger). */
export const errosMensagens = {
  /** 190: token expirado/revogado (a Graph devolve 400 com OAuthException; subcode 463 = expirado). */
  tokenExpirado: () => erroMeta(400, 190, 'Error validating access token: Session has expired on Thursday, 22-Oct-26 10:00:00 PDT.', { error_subcode: 463 }),
  /** 4: limite de chamadas da aplicação. */
  limiteApp: () => erroMeta(400, 4, '(#4) Application request limit reached', { is_transient: true }),
  /** 17: limite por usuário. */
  limiteUsuario: () => erroMeta(400, 17, '(#17) User request limit reached', { is_transient: true }),
  /** 32: limite de páginas. */
  limitePagina: () => erroMeta(400, 32, '(#32) Page request limit reached', { is_transient: true }),
  /** 613: limite de chamadas personalizado. */
  limite613: () => erroMeta(400, 613, 'Calls to this api have exceeded the rate limit.', { is_transient: true }),
  /** 80002: limite de uso de negócio do Instagram (Business Use Case). */
  limiteInstagramBuc: () => erroMeta(400, 80002, 'There have been too many calls to this Instagram account. Wait a bit and try again.', { is_transient: true }),
  /** 80006: limite de uso de negócio do Messenger (Business Use Case). */
  limiteMessengerBuc: () => erroMeta(400, 80006, 'There have been too many calls to this Page account. Wait a bit and try again.', { is_transient: true }),
  /** HTTP 429 puro com Retry-After. */
  http429: () => erroMeta(429, 4, 'Too many requests', {}, { 'Retry-After': '3' }),
  /** 10: aplicação sem permissão. */
  semPermissao: () => erroMeta(400, 10, '(#10) Application does not have permission for this action', { error_subcode: 2018028 }),
  /** 200: permissão ausente. */
  permissao200: () => erroMeta(403, 200, '(#200) Requires pages_messaging permission to manage the object'),
  /** 551: usuário indisponível (bloqueou a conta ou desativou o perfil). */
  usuarioIndisponivel: () => erroMeta(400, 551, "(#551) This person isn't available right now.", { error_subcode: 1545041 }),
  /** 10 + subcode 2018278: fora da janela padrão de 24 h. */
  foraDaJanela: () => erroMeta(400, 10, '(#10) This message is sent outside of allowed window.', { error_subcode: 2018278 }),
  /** 100: parâmetro inválido. */
  parametroInvalido: () => erroMeta(400, 100, '(#100) Invalid parameter', { error_subcode: 2534014 }),
  /** 5xx: instabilidade do servidor. */
  interno: () => erroMeta(500, 2, 'An unexpected error has occurred. Please retry your request later.', { is_transient: true }),
}

export interface ConfigSimuladorMensagens { host: string; contaId: string; rotuloConta: 'instagram' | 'messenger'; nome: string }

export class SimuladorMensagens implements Simulador {
  nome: string
  token = 'TOKEN-SIMULADO-MSG'
  contaId: string
  enviadas: Enviada[] = []
  /** `consulta` é a query da URL como veio (sem o `?`), para provar o que não pode aparecer nela (ex.: o token). */
  chamadas: { metodo: string; caminho: string; consulta: string; corpo: unknown; em: number }[] = []
  falhas: Falha[] = []
  /** Destinatários cuja janela de 24 h já fechou. */
  janelaFechada = new Set<string>()
  /** Destinatários que bloquearam a conta. */
  indisponiveis = new Set<string>()
  private seq = 0
  constructor(private cfg: ConfigSimuladorMensagens) { this.nome = cfg.nome; this.contaId = cfg.contaId }
  aceita(url: URL) { return url.host === this.cfg.host }
  programar(f: Falha) { this.falhas.push(f); return this }
  /** Chamadas de envio (POST /messages). */
  get envios() { return this.chamadas.filter(c => c.metodo === 'POST' && c.caminho.endsWith('/messages')) }
  async trata(req: Request, url: URL): Promise<Response> {
    const texto = req.method === 'GET' ? '' : await req.text()
    // Formulário (como a Graph aceita em /{app-id}/subscriptions) vira objeto; o resto é JSON.
    const formulario = req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')
    const corpo = !texto ? null : formulario ? Object.fromEntries(new URLSearchParams(texto)) : JSON.parse(texto)
    this.chamadas.push({ metodo: req.method, caminho: url.pathname, consulta: url.search.replace(/^\?/, ''), corpo, em: Date.now() })
    const auth = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? url.searchParams.get('access_token')
    if (!this.tokenAceito(auth, req, url)) return errosMensagens.tokenExpirado()
    const idx = this.falhas.findIndex(f => !f.quando || f.quando(req, url, corpo))
    if (idx >= 0) {
      const f = this.falhas[idx]
      f.vezes = (f.vezes ?? 1) - 1
      if (f.vezes <= 0) this.falhas.splice(idx, 1)
      return f.resposta()
    }
    const propria = await this.rota(req, url, corpo)
    if (propria) return propria
    const m = url.pathname.match(/^\/v\d+\.\d+\/([^/]+)(\/messages)?$/)
    if (!m) return erroMeta(400, 100, `Unsupported request - method type: ${req.method}`, { error_subcode: 33 })
    const [, alvo, mensagens] = m
    if (mensagens) return req.method === 'POST' && (alvo === this.contaId || alvo === 'me') ? this.enviar(corpo) : erroMeta(400, 100, 'Unsupported post request. Object with ID does not exist', { error_subcode: 33 })
    if (req.method !== 'GET') return erroMeta(400, 100, 'Unsupported request', { error_subcode: 33 })
    if (alvo === 'me' || alvo === this.contaId) {
      return Response.json(this.cfg.rotuloConta === 'instagram'
        ? { user_id: this.contaId, id: this.contaId, username: 'oficina_horizonte' }
        : { id: this.contaId, name: 'Oficina Horizonte' })
    }
    return Response.json(this.cfg.rotuloConta === 'instagram'
      ? { name: 'Pessoa de Teste', username: `usuario_${alvo}`, profile_pic: 'https://scontent.example.com/pic.jpg' }
      : { first_name: 'Pessoa', last_name: 'de Teste', profile_pic: 'https://scontent.example.com/pic.jpg' })
  }
  /** Gancho das subclasses: rotas próprias (por exemplo, as do login unificado). Devolver `undefined` deixa a base responder. */
  protected rota(_req: Request, _url: URL, _corpo: any): Response | undefined | Promise<Response | undefined> { return undefined }
  /** Gancho das subclasses: credenciais além do token da conta (por exemplo, o token do app em rotas do app). */
  protected tokenAceito(auth: string | null, _req: Request, _url: URL): boolean { return auth === this.token }
  private enviar(corpo: any): Response {
    const para = String(corpo?.recipient?.id ?? '')
    if (!para) return errosMensagens.parametroInvalido()
    const msg = corpo?.message
    if (!msg || (msg.text === undefined && !msg.attachment)) return errosMensagens.parametroInvalido()
    if (this.indisponiveis.has(para)) return errosMensagens.usuarioIndisponivel()
    if (this.janelaFechada.has(para) && corpo.tag !== 'HUMAN_AGENT') return errosMensagens.foraDaJanela()
    let texto = '', botoes: Enviada['botoes'] = []
    if (msg.attachment) {
      if (msg.attachment.type !== 'template') return errosMensagens.parametroInvalido()
      const p = msg.attachment.payload
      if (p?.template_type === 'button') {
        texto = p.text ?? ''
        botoes = (p.buttons ?? []).filter((b: any) => b.type === 'postback').map((b: any) => ({ id: b.payload, titulo: b.title }))
      } else texto = (p?.elements ?? []).map((e: any) => e.title).join(' | ')
    } else {
      texto = msg.text
      botoes = (msg.quick_replies ?? []).map((q: any) => ({ id: q.payload, titulo: q.title }))
    }
    const message_id = `m_SIM${(++this.seq).toString().padStart(8, '0')}`
    this.enviadas.push({ para, texto, botoes, bruto: corpo })
    return Response.json({ recipient_id: para, message_id })
  }
}
