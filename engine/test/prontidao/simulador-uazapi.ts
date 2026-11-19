/**
 * Servidor UAZAPI (uazapiGO v2.6.7) falso. Formatos conferidos em ~/Projetos/uzapi/docs/v2.6.7/openapi.json:
 * cabeçalho `token` da instância; GET /instance/status {instance,status}; POST /instance/connect; POST /webhook; POST /send/text e
 * POST /send/menu (type "button", choices "titulo|id") respondem {id, messageid, response}; 401 {error:'Invalid token'}; 429 {error:'Rate limit exceeded'}
 * (com Retry-After); 500 do WhatsApp {error, error_source:'whatsapp_server', error_key, provider_code}.
 * NÃO DOCUMENTADO (escolhido aqui, ver relatório): erro de envio para número que não está no WhatsApp (usa 400 {error}) e de instância offline
 * (usa 500 {error:'WhatsApp client is not connected'}, o texto que a documentação mostra em /chat/check).
 */
import type { Enviada, Falha, Simulador } from './simuladores'

export const UAZAPI_HOST = 'loja.uazapi.com'
export const UAZAPI_SERVER = `https://${UAZAPI_HOST}`

export const uazapiErros = {
  tokenInvalido: () => Response.json({ error: 'Invalid token' }, { status: 401 }),
  limite: (segundos = 3) => Response.json({ error: 'Rate limit exceeded' }, { status: 429, headers: { 'Retry-After': String(segundos) } }),
  /** O servidor do WhatsApp recusou (exemplo oficial do 500 do sendText). */
  whatsappRecusou: () => Response.json({ error: 'WhatsApp server error 463: WhatsApp reported that the currently connected account is under a temporary restriction for starting new conversations, usually related to sending volume or quality.',
    error_source: 'whatsapp_server', provider: 'whatsapp', provider_code: 463, error_key: 'WHATSAPP_REACHOUT_TIMELOCK' }, { status: 500 }),
  instanciaOffline: () => Response.json({ error: 'WhatsApp client is not connected' }, { status: 500 }),
  numeroInexistente: () => Response.json({ error: 'Number is not on WhatsApp' }, { status: 400 }),
  generico500: () => Response.json({ error: 'Failed to send message' }, { status: 500 }),
  bruto502: () => new Response('<html>Bad Gateway</html>', { status: 502 }),
}

export class Uazapi implements Simulador {
  nome = 'uazapi'
  token = 'UZ-TOKEN-SIMULADO'
  dono = '5511999999999'
  instancia: { id: string; status: 'disconnected' | 'connecting' | 'connected'; qrcode?: string; profileName?: string } = { id: 'r183e2ef', status: 'disconnected' }
  webhook: Record<string, unknown> | null = null
  enviadas: Enviada[] = []
  falhas: Falha[] = []
  chamadas: { metodo: string; caminho: string; corpo: unknown }[] = []
  private seq = 0
  aceita(url: URL) { return url.host === UAZAPI_HOST }
  programar(f: Falha) { this.falhas.push(f); return this }
  /** O usuário leu o QR no celular. */
  parear() { this.instancia = { ...this.instancia, status: 'connected', qrcode: undefined, profileName: 'Oficina Horizonte' } }
  async trata(req: Request, url: URL): Promise<Response> {
    const texto = req.method === 'GET' ? '' : await req.text()
    const corpo = (texto ? JSON.parse(texto) : {}) as any
    this.chamadas.push({ metodo: req.method, caminho: url.pathname, corpo })
    if (req.headers.get('token') !== this.token) return uazapiErros.tokenInvalido()
    const idx = this.falhas.findIndex(f => !f.quando || f.quando(req, url, corpo))
    if (idx >= 0) { const f = this.falhas[idx]; f.vezes = (f.vezes ?? 1) - 1; if (f.vezes <= 0) this.falhas.splice(idx, 1); return f.resposta() }
    switch (url.pathname) {
      case '/instance/status': return Response.json({ instance: this.instancia, status: { connected: this.instancia.status === 'connected', loggedIn: this.instancia.status === 'connected' } })
      case '/instance/connect':
        if (this.instancia.status !== 'connected') this.instancia = { ...this.instancia, status: 'connecting', qrcode: 'data:image/png;base64,QR-SIMULADO' }
        return Response.json({ response: 'Connecting', instance: this.instancia })
      case '/webhook': this.webhook = corpo; return Response.json([{ id: 'wh1', enabled: corpo.enabled !== false, url: corpo.url }])
      case '/message/markread': return Response.json({ success: true })
      case '/message/find': return Response.json({ messages: [], pagination: { limit: 100, offset: 0, hasMore: false, nextOffset: 0 } })
      case '/send/text': case '/send/menu': return this.enviar(url.pathname, corpo)
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  }
  private enviar(caminho: string, corpo: any) {
    if (this.instancia.status !== 'connected') return uazapiErros.instanciaOffline()
    if (!corpo.number || !(caminho === '/send/text' ? corpo.text : corpo.text && Array.isArray(corpo.choices) && corpo.type === 'button')) return Response.json({ error: caminho === '/send/text' ? 'Missing number or text' : 'Missing required fields or invalid menu type' }, { status: 400 })
    const botoes = caminho === '/send/menu' ? (corpo.choices as string[]).map(c => { const i = c.indexOf('|'); return { titulo: c.slice(0, i), id: c.slice(i + 1) } }).map(b => ({ id: b.id, titulo: b.titulo })) : []
    const messageid = `OUT${(++this.seq).toString().padStart(6, '0')}`
    this.enviadas.push({ para: String(corpo.number), texto: corpo.text, botoes, bruto: corpo })
    return Response.json({ id: `${this.dono}:${messageid}`, messageid, response: { status: 'success', message: caminho === '/send/text' ? 'Message sent successfully' : 'Menu sent successfully' } })
  }
}

/** Corpos do webhook da UAZAPI (EventType messages / messages_update). O token da instância vem no corpo: é a única prova da entrega. */
export const webhooksUazapi = {
  jid: (usuario: string) => `${usuario}@s.whatsapp.net`,
  mensagem(sim: Uazapi, usuario: string, id: string, texto: string, extra: Record<string, unknown> = {}) {
    return { EventType: 'messages', owner: sim.dono, token: sim.token, BaseUrl: UAZAPI_SERVER, instanceName: 'Oficina', chat: { name: 'Pessoa de teste' },
      message: { id: `${sim.dono}:${id}`, messageid: id, chatid: webhooksUazapi.jid(usuario), sender: webhooksUazapi.jid(usuario), senderName: 'Pessoa de teste', fromMe: false, isGroup: false,
        messageType: 'Conversation', text: texto, messageTimestamp: Date.now() - 1000, ...extra } }
  },
  clique: (sim: Uazapi, usuario: string, id: string, botaoId: string, titulo: string) => webhooksUazapi.mensagem(sim, usuario, id, titulo, { messageType: 'ButtonsResponseMessage', buttonOrListid: botaoId }),
  recibo: (sim: Uazapi, usuario: string, messageid: string, estado: 'Delivered' | 'Read') => ({ EventType: 'messages_update', owner: sim.dono, token: sim.token, instanceName: 'Oficina', type: 'ReadReceipt', state: estado,
    event: { MessageIDs: [messageid], Chat: webhooksUazapi.jid(usuario), IsFromMe: true, IsGroup: false, Timestamp: Math.floor(Date.now() / 1000) } }),
}
