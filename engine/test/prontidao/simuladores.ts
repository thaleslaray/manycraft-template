/**
 * Provedores falsos para o teste de prontidão. Respondem como os reais (formatos da documentação oficial) e nunca saem da máquina:
 * quem usa instala `instalarRede(...)`, que troca o `fetch` global; qualquer host desconhecido derruba o teste.
 */
import { vi } from 'vitest'

export type Enviada = { em?: number; para: string; texto: string; botoes: { id: string; titulo: string }[]; modelo?: { nome: string; idioma: string; parametros: string[] }; bruto: unknown }
export interface Simulador {
  nome: string
  aceita(url: URL): boolean
  trata(req: Request, url: URL): Promise<Response>
}

/** Troca o fetch global pelos simuladores; host fora da lista falha alto (nada de rede real, nunca). */
export function instalarRede(...sims: Simulador[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init)
    const url = new URL(req.url)
    const sim = sims.find(s => s.aceita(url))
    if (!sim) throw new Error(`Rede real proibida no teste de prontidão: ${url.host}`)
    return sim.trata(req, url)
  })
}

let contador = 0
export const proximoId = (prefixo: string) => `${prefixo}${Date.now().toString(36)}${(++contador).toString(36)}`

/** Um erro programado: casa com a próxima chamada que satisfizer `quando` e vale `vezes` chamadas (padrão 1). */
export type Falha = { quando?: (req: Request, url: URL, corpo: unknown) => boolean; vezes?: number; resposta: () => Response }

// ───────────────────────────── Meta Graph API (WhatsApp Cloud) ─────────────────────────────
export type ModeloRemoto = { id: string; name: string; language: string; status: string; category: string; parameter_format?: string; quality_score?: { score: string }; rejected_reason?: string; components: unknown[] }

/** Formato de erro da Graph API: https://developers.facebook.com/docs/graph-api/guides/error-handling */
export const erroMeta = (status: number, code: number, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  Response.json({ error: { message, type: code === 190 ? 'OAuthException' : 'OAuthException', code, ...extra, fbtrace_id: 'AbCdEf123' } }, { status, headers })
export const erros = {
  /** Token expirado/revogado. */
  tokenExpirado: () => erroMeta(401, 190, 'Error validating access token: Session has expired on Thursday, 22-Oct-26 10:00:00 PDT.', { error_subcode: 463 }),
  /** Limite de chamadas da aplicação. */
  limiteApp: () => erroMeta(400, 4, '(#4) Application request limit reached', { is_transient: true }),
  /** Limite de taxa da conta do WhatsApp Business (WABA). */
  limiteWaba: () => erroMeta(400, 80007, 'Rate limit issues', { error_data: { messaging_product: 'whatsapp', details: 'Rate limit hit' } }),
  /** Vazão por número (pares por segundo). */
  vazao: () => erroMeta(400, 130429, 'Rate limit hit', { error_data: { messaging_product: 'whatsapp', details: 'Cloud API message throughput has been reached.' } }),
  /** HTTP 429 puro, com Retry-After. */
  http429: () => erroMeta(429, 4, 'Too many requests', {}, { 'Retry-After': '3' }),
  /** Aplicação sem permissão. */
  semPermissao: () => erroMeta(403, 10, '(#10) Application does not have permission for this action', { error_subcode: 2018028 }),
  permissaoWhatsapp: () => erroMeta(400, 200, '(#200) Requires whatsapp_business_messaging permission to manage the object'),
  /** Destinatário fora da lista de números permitidos (número de teste). */
  fora_da_lista: () => erroMeta(400, 131030, 'Recipient phone number not in allowed list', { error_data: { messaging_product: 'whatsapp', details: 'Recipient phone number not in allowed list: Add recipient phone number to recipient list and try again.' } }),
  /** Fora da janela de 24 h. */
  foraDaJanela: () => erroMeta(400, 131047, 'Re-engagement message', { error_data: { messaging_product: 'whatsapp', details: 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.' } }),
  /** Outro app é o dono da conversa (Conversation Routing). */
  outroAppControla: () => erroMeta(400, 131070, 'Another app is controlling this thread now', { error_data: { messaging_product: 'whatsapp', details: 'Another app is controlling this thread now.' } }),
  /** A Meta não conseguiu baixar a mídia do link (expirado). */
  midiaIndisponivel: () => erroMeta(400, 131053, 'Media upload error', { error_data: { messaging_product: 'whatsapp', details: 'Media upload error: unable to download the media from the link.' } }),
  /** Modelo pausado. */
  modeloPausado: () => erroMeta(400, 132015, 'Template is paused', { error_data: { messaging_product: 'whatsapp', details: 'Template is paused due to low quality so it cannot be sent in a template message.' } }),
  /** Modelo inexistente ou não aprovado nesse idioma. */
  modeloInexistente: () => erroMeta(404, 132001, 'Template name does not exist in the translation', { error_data: { messaging_product: 'whatsapp', details: 'template name (x) does not exist in pt_BR' } }),
  /** Instabilidade do servidor. */
  interno: () => erroMeta(500, 131000, 'Something went wrong', { error_data: { messaging_product: 'whatsapp', details: 'Something went wrong' } }),
}

export class MetaGraph implements Simulador {
  nome = 'meta-graph'
  token = 'TOKEN-SIMULADO'
  waba = '456'
  telefoneId = '123456789'
  modelos: ModeloRemoto[] = []
  porPagina = 100
  enviadas: Enviada[] = []
  chamadas: { metodo: string; caminho: string; corpo: unknown; em: number }[] = []
  falhas: Falha[] = []
  /** Atraso artificial por envio, para medir fila/concorrência. */
  atrasoMs = 0
  /** Conversation Routing: outro app da conta controla a conversa; a Meta recusa o envio com 131070. */
  outroAppControla = false
  /** Conversation Routing (docs/whatsapp/conversation-routing): quando `ativo`, só o dono da conversa (ou o parceiro de escalonamento) responde. */
  roteamento: { ativo: boolean; papeis: string[]; standby: boolean } = { ativo: false, papeis: [], standby: false }
  /** Dono atual de cada conversa (telefone ou BSUID do usuário); `null`/ausente = conversa ociosa. */
  donos = new Map<string, string | null>()
  /** Links de mídia que a Meta não consegue mais baixar (URL expirada). */
  midiaExpirada = new Set<string>()
  private seq = 0
  aceita(url: URL) { return url.host === 'graph.facebook.com' }
  programar(f: Falha) { this.falhas.push(f); return this }
  async trata(req: Request, url: URL): Promise<Response> {
    const corpoTexto = req.method === 'GET' ? '' : await req.text()
    const corpo = corpoTexto ? JSON.parse(corpoTexto) : null
    this.chamadas.push({ metodo: req.method, caminho: url.pathname, corpo, em: Date.now() })
    if (req.headers.get('authorization') !== `Bearer ${this.token}`) return erros.tokenExpirado()
    const idx = this.falhas.findIndex(f => !f.quando || f.quando(req, url, corpo))
    if (idx >= 0) {
      const f = this.falhas[idx]
      f.vezes = (f.vezes ?? 1) - 1
      if (f.vezes <= 0) this.falhas.splice(idx, 1)
      return f.resposta()
    }
    const rota = url.pathname.replace(/^\/v\d+\.\d+/, '')
    if (rota === `/${this.waba}/message_templates`) return req.method === 'GET' ? this.listar(url) : this.criar(corpo)
    if (rota === `/${this.telefoneId}/messages` && req.method === 'POST') return this.enviar(corpo)
    if (rota === `/${this.telefoneId}/routing_roles` && req.method === 'GET') return this.papeis()
    if (rota === `/${this.telefoneId}/thread_control` && req.method === 'POST') return this.controlar(corpo)
    // A Meta real recusa whatsapp_business_account no nó do número (#100); a conta se prova listando os números da WABA.
    if (rota === `/${this.telefoneId}` && req.method === 'GET') return url.searchParams.get('fields')?.includes('whatsapp_business_account')
      ? erroMeta(400, 100, '(#100) Tried accessing nonexisting field (whatsapp_business_account) on node type (WhatsAppBusinessPhoneNumber)')
      : Response.json({ verified_name: 'Oficina Horizonte', display_phone_number: '+55 11 4000-0000', id: this.telefoneId, quality_rating: 'GREEN' })
    if (rota === `/${this.waba}/phone_numbers` && req.method === 'GET') return Response.json({ data: [{ id: this.telefoneId }] })
    return erroMeta(400, 100, `Unsupported request - method type: ${req.method}`, { error_subcode: 33 })
  }
  private papeis() {
    if (!this.roteamento.ativo) return erroMeta(400, 100, 'Method not supported for this endpoint.')
    return Response.json({ roles: this.roteamento.papeis, is_standby: this.roteamento.standby })
  }
  /** https://developers.facebook.com/documentation/business-messaging/whatsapp/conversation-routing/thread-control */
  private controlar(corpo: any) {
    if (!this.roteamento.ativo) return erroMeta(400, 100, 'Method not supported for this endpoint.')
    if (corpo?.messaging_product !== 'whatsapp' || !['pass', 'release', 'take'].includes(corpo?.action)) return erroMeta(400, 100, 'Invalid parameter')
    if (!corpo.to === !corpo.recipient) return erroMeta(400, 100, corpo.to ? '(#100) Provide only one of to or recipient, not both.' : '(#100) Exactly one of to or recipient is required.')
    if (corpo.control_pass && corpo.action !== 'pass') return erroMeta(400, 100, '(#100) control_pass is only supported for the pass action.')
    const usuario = String(corpo.to ?? corpo.recipient), meu = this.roteamento.papeis
    const dono = this.donos.get(usuario) ?? null
    if (corpo.action === 'take') {
      if (!meu.includes('escalation')) return erroMeta(400, 2494191, 'You are not permitted to take thread control for this phone number.')
      this.donos.set(usuario, 'escalation')
    } else {
      if (!dono || !meu.includes(dono)) return erroMeta(400, 100, '(#100) Thread is not owned by the caller.')
      if (corpo.action === 'release') this.donos.set(usuario, null)
      else this.donos.set(usuario, corpo.control_pass?.target_role ?? 'escalation')
    }
    return Response.json({ messaging_product: 'whatsapp', request_id: `req.SIM${this.chamadas.length}` })
  }
  private listar(url: URL) {
    const inicio = url.searchParams.has('after') ? Number(atob(url.searchParams.get('after')!)) : 0
    const limite = Math.min(Number(url.searchParams.get('limit') ?? 25), this.porPagina)
    const pedidos = (url.searchParams.get('fields') ?? '').split(',').filter(Boolean)
    const fatia = this.modelos.slice(inicio, inicio + limite).map(m => pedidos.length ? Object.fromEntries(Object.entries(m).filter(([k]) => ['id', ...pedidos].includes(k))) : m)
    const fim = inicio + limite
    const corpo: Record<string, unknown> = { data: fatia, paging: { cursors: { before: btoa(String(inicio)), after: btoa(String(Math.min(fim, this.modelos.length))) } } }
    if (fim < this.modelos.length) {
      const proxima = new URL(url); proxima.searchParams.set('after', btoa(String(fim)))
      ;(corpo.paging as Record<string, unknown>).next = proxima.toString()
    }
    return Response.json(corpo)
  }
  private criar(corpo: any) {
    if (!corpo?.name || !corpo?.language || !corpo?.category || !Array.isArray(corpo.components)) return erroMeta(400, 100, 'Invalid parameter', { error_subcode: 2388023 })
    if (this.modelos.some(m => m.name === corpo.name && m.language === corpo.language)) return erroMeta(400, 100, 'Invalid parameter', { error_subcode: 2388024, error_user_title: 'Content in this language already exists' })
    const id = String(900000 + this.modelos.length + 1)
    this.modelos.push({ id, name: corpo.name, language: corpo.language, status: 'PENDING', category: corpo.category, parameter_format: corpo.parameter_format, components: corpo.components })
    return Response.json({ id, status: 'PENDING', category: corpo.category })
  }
  private async enviar(corpo: any) {
    if (this.atrasoMs) await new Promise(r => setTimeout(r, this.atrasoMs))
    if (this.outroAppControla) return erros.outroAppControla()
    if (this.roteamento.ativo) {
      const dono = this.donos.get(String(corpo?.recipient ?? corpo?.to ?? '')) ?? null
      const meu = this.roteamento.papeis
      if (corpo?.type !== 'template' && !meu.includes('escalation') && !(dono && meu.includes(dono))) return erros.outroAppControla()
    }
    if (corpo?.messaging_product !== 'whatsapp') return erroMeta(400, 100, 'Invalid parameter', { error_data: { details: 'messaging_product is required' } })
    const para = String(corpo.recipient ?? corpo.to ?? '')
    if (!para) return erroMeta(400, 100, 'Invalid parameter', { error_data: { details: 'recipient is required' } })
    let texto = '', botoes: Enviada['botoes'] = [], modelo: Enviada['modelo']
    if (corpo.type === 'text') texto = corpo.text?.body ?? ''
    else if (corpo.type === 'interactive') {
      texto = corpo.interactive?.body?.text ?? ''
      botoes = (corpo.interactive?.action?.buttons ?? []).map((b: any) => ({ id: b.reply.id, titulo: b.reply.title }))
    } else if (corpo.type === 'template') {
      const t = corpo.template
      const achado = this.modelos.find(m => m.name === t?.name && m.language === t?.language?.code)
      if (!achado) return erros.modeloInexistente()
      if (achado.status === 'PAUSED') return erros.modeloPausado()
      if (achado.status !== 'APPROVED') return erros.modeloInexistente()
      const params = (t.components ?? []).flatMap((c: any) => c.parameters ?? []).map((p: any) => p.text ?? '')
      modelo = { nome: t.name, idioma: t.language.code, parametros: params }
      const corpoModelo = (achado.components as any[]).find(c => c.type === 'BODY')?.text ?? ''
      texto = corpoModelo.replace(/\{\{\s*[\w]+\s*\}\}/g, () => params.shift() ?? '')
      modelo.parametros = (t.components ?? []).flatMap((c: any) => c.parameters ?? []).map((p: any) => p.text ?? '')
    } else if (['image', 'video', 'audio', 'document'].includes(corpo.type)) {
      const link = corpo[corpo.type]?.link
      if (typeof link !== 'string') return erroMeta(400, 100, 'Invalid parameter', { error_data: { details: 'link or id is required' } })
      if (this.midiaExpirada.has(link)) return erros.midiaIndisponivel()
      texto = `[${corpo.type}] ${link}${corpo[corpo.type].caption ? ' ' + corpo[corpo.type].caption : ''}`
    } else return erroMeta(400, 100, 'Invalid parameter', { error_data: { details: `Unsupported type ${corpo.type}` } })
    const id = `wamid.SIM${(++this.seq).toString().padStart(8, '0')}`
    this.enviadas.push({ em: Date.now(), para, texto, botoes, modelo, bruto: corpo })
    return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: para, wa_id: para }], messages: [{ id }] })
  }
}

/** Corpos de webhook da WhatsApp Cloud API (campo `messages`), com BSUID e telefone como na documentação. */
export const webhooksWhatsapp = {
  envelope(telefoneId: string, mensagens: unknown[] = [], statuses: unknown[] = [], contatos: unknown[] = [], waba = '456') {
    return { object: 'whatsapp_business_account', entry: [{ id: waba, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
      metadata: { display_phone_number: '551140000000', phone_number_id: telefoneId }, ...(contatos.length ? { contacts: contatos } : {}),
      ...(mensagens.length ? { messages: mensagens } : {}), ...(statuses.length ? { statuses } : {}) } }] }] }
  },
  /** Campo `messaging_handovers` (control_passed / control_taken), como na página Thread control. */
  troca(telefoneId: string, usuario: string, tipo: 'control_passed' | 'control_taken', de: string, para: string, em = Math.floor(Date.now() / 1000), waba = '456') {
    return { object: 'whatsapp_business_account', entry: [{ id: waba, changes: [{ field: 'messaging_handovers', value: { messaging_product: 'whatsapp',
      sender: { user_id: usuario }, recipient: { phone_number_id: telefoneId, display_phone_number: '551140000000' }, type: tipo, timestamp: String(em),
      [tipo]: { previous_owner_role: de, new_owner_role: para, metadata: 'teste' } } }] }] }
  },
  contato: (usuario: string, nome = 'Pessoa de teste') => ({ profile: { name: nome }, wa_id: `55119${usuario.replace(/\D/g, '').padStart(8, '0').slice(-8)}`, user_id: usuario }),
  texto: (usuario: string, id: string, texto: string, em = Math.floor(Date.now() / 1000)) => ({ from: `55119${usuario.replace(/\D/g, '').padStart(8, '0').slice(-8)}`, from_user_id: usuario, id, timestamp: String(em), type: 'text', text: { body: texto } }),
  clique: (usuario: string, id: string, botaoId: string, titulo: string, em = Math.floor(Date.now() / 1000)) => ({ from: `55119${usuario.replace(/\D/g, '').padStart(8, '0').slice(-8)}`, from_user_id: usuario, id, timestamp: String(em), type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: botaoId, title: titulo } } }),
  status: (id: string, status: 'sent' | 'delivered' | 'read' | 'failed', destinatario: string, em = Math.floor(Date.now() / 1000)) => ({ id, status, timestamp: String(em), recipient_id: destinatario,
    ...(status === 'failed' ? { errors: [{ code: 131026, title: 'Message undeliverable' }] } : {}) }),
}

// ───────────────────────────── Telegram Bot API ─────────────────────────────
export class TelegramBot implements Simulador {
  nome = 'telegram'
  token = '111222:SIMULADO-bot-token'
  segredoWebhook = ''
  enviadas: Enviada[] = []
  falhas: Falha[] = []
  private seq = 0
  aceita(url: URL) { return url.host === 'api.telegram.org' }
  programar(f: Falha) { this.falhas.push(f); return this }
  async trata(req: Request, url: URL): Promise<Response> {
    const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/)
    if (!m) return Response.json({ ok: false, error_code: 404, description: 'Not Found' }, { status: 404 })
    if (m[1] !== this.token) return Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 })
    const corpo = req.method === 'POST' ? await req.json().catch(() => ({})) as any : {}
    const idx = this.falhas.findIndex(f => !f.quando || f.quando(req, url, corpo))
    if (idx >= 0) { const f = this.falhas[idx]; f.vezes = (f.vezes ?? 1) - 1; if (f.vezes <= 0) this.falhas.splice(idx, 1); return f.resposta() }
    if (m[2] === 'getMe') return Response.json({ ok: true, result: { id: 111222, is_bot: true, first_name: 'Oficina Horizonte', username: 'oficina_horizonte_bot' } })
    if (m[2] === 'setWebhook') { this.segredoWebhook = String(corpo.secret_token ?? ''); return Response.json({ ok: true, result: true, description: 'Webhook was set' }) }
    if (m[2] === 'sendMessage') {
      if (!corpo.chat_id || !corpo.text) return Response.json({ ok: false, error_code: 400, description: 'Bad Request: message text is empty' }, { status: 400 })
      const botoes = (corpo.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => ({ id: b.callback_data, titulo: b.text }))
      this.enviadas.push({ para: String(corpo.chat_id), texto: corpo.text, botoes, bruto: corpo })
      return Response.json({ ok: true, result: { message_id: 10000 + (++this.seq), date: Math.floor(Date.now() / 1000), chat: { id: corpo.chat_id, type: 'private' }, text: corpo.text } })
    }
    return Response.json({ ok: true, result: true })
  }
}
export const telegramErros = {
  bloqueado: () => Response.json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, { status: 403 }),
  limite: (segundos = 2) => Response.json({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${segundos}`, parameters: { retry_after: segundos } }, { status: 429, headers: { 'Retry-After': String(segundos) } }),
  tokenRevogado: () => Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 }),
  chatInexistente: () => Response.json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, { status: 400 }),
}
