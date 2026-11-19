/**
 * Z-API clássica falsa (api.z-api.io, instâncias). Formatos conferidos na skill docs-zapi (espelho de developer.z-api.io):
 * URL /instances/{instanceId}/token/{token}/<rota> com o cabeçalho Client-Token; GET /status {connected,error,smartphoneConnected}; GET /qr-code {value};
 * PUT update-webhook-{received,delivery,message-status,connected,disconnected} {value} -> {value:true}; PUT update-notify-sent-by-me;
 * POST send-text / send-button-list / send-button-actions -> {zaapId,messageId,id}.
 * NÃO DOCUMENTADO (suposto aqui, como em src/channels/zapi.ts): o corpo e o status HTTP de um envio recusado (só 400 genérico), o envio com a
 * instância desconectada, o 429 com Retry-After (AC-14: a doc não publica limite) e se os `ids` do callback de status são o `messageId` do envio.
 */
import type { Enviada, Falha, Simulador } from './simuladores'

export const ZAPI_HOST = 'api.z-api.io'

export const zapiErros = {
  tokenInvalido: () => Response.json({ error: 'null not allowed' }, { status: 401 }),
  semPermissao: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
  desconectado: () => Response.json({ error: 'You are not connected.' }, { status: 400 }),
  numeroInexistente: () => Response.json({ error: 'Phone number does not exist' }, { status: 400 }),
  limite: (segundos = 3) => Response.json({ error: 'rate limit' }, { status: 429, headers: { 'Retry-After': String(segundos) } }),
  interno500: () => Response.json({ error: 'internal_error' }, { status: 500 }),
}

export class ZapiClassica implements Simulador {
  nome = 'zapi'
  instanceId = 'A0000000000000000000000000000000'
  token = 'TOKENSIMULADO0123456789'
  clientToken = 'client-token-simulado-1'
  dono = '5511999999999'
  pareado = false
  /** URL registrada em cada webhook, pelo nome da rota (`received`, `delivery`, `message-status`, `connected`, `disconnected`). */
  webhooks = new Map<string, string>()
  notificaEnviadasPorMim = false
  enviadas: Enviada[] = []
  falhas: Falha[] = []
  chamadas: { metodo: string; caminho: string; corpo: unknown }[] = []
  private seq = 0
  aceita(url: URL) { return url.host === ZAPI_HOST }
  programar(f: Falha) { this.falhas.push(f); return this }
  parear() { this.pareado = true }
  /** O segredo que a Z-API devolve em cada entrega: o que veio na URL registrada. */
  get segredoDoHook() { return new URL(this.webhooks.get('received') ?? 'https://x.invalid/?k=').searchParams.get('k') ?? '' }
  async trata(req: Request, url: URL): Promise<Response> {
    const texto = req.method === 'GET' ? '' : await req.text()
    const corpo = (texto ? JSON.parse(texto) : {}) as any
    this.chamadas.push({ metodo: req.method, caminho: url.pathname, corpo })
    const base = `/instances/${this.instanceId}/token/${this.token}`
    if (req.headers.get('client-token') !== this.clientToken || !url.pathname.startsWith(base)) return zapiErros.tokenInvalido()
    const idx = this.falhas.findIndex(f => !f.quando || f.quando(req, url, corpo))
    if (idx >= 0) { const f = this.falhas[idx]; f.vezes = (f.vezes ?? 1) - 1; if (f.vezes <= 0) this.falhas.splice(idx, 1); return f.resposta() }
    const rota = url.pathname.slice(base.length)
    if (rota === '/status') return Response.json({ connected: this.pareado, error: this.pareado ? 'You are already connected' : 'You are not connected', smartphoneConnected: this.pareado })
    if (rota === '/qr-code') return Response.json({ value: 'data:image/png;base64,QR-SIMULADO' })
    if (req.method === 'PUT' && rota.startsWith('/update-webhook-')) { this.webhooks.set(rota.slice('/update-webhook-'.length), corpo.value); return Response.json({ value: true }) }
    if (req.method === 'PUT' && rota === '/update-notify-sent-by-me') { this.notificaEnviadasPorMim = corpo.notifySentByMe === true; return Response.json({ value: true }) }
    if (req.method === 'PUT' && rota === '/update-queue-settings') return Response.json({ value: true })
    if (req.method === 'POST' && /^\/send-(text|button-list|button-actions)$/.test(rota)) return this.enviar(rota, corpo)
    return Response.json({ error: 'not found' }, { status: 404 })
  }
  private enviar(rota: string, corpo: any) {
    if (!this.pareado) return zapiErros.desconectado()
    if (!corpo.phone || !corpo.message) return Response.json({ error: 'phone and message are required' }, { status: 400 })
    const lista = rota === '/send-button-list' ? corpo.buttonList?.buttons : rota === '/send-button-actions' ? corpo.buttonActions : []
    const botoes = (lista ?? []).map((b: any) => ({ id: String(b.id), titulo: String(b.label) }))
    this.enviadas.push({ para: String(corpo.phone), texto: corpo.message, botoes, bruto: corpo })
    const id = `OUT${(++this.seq).toString()}`.padEnd(32, '0')
    return Response.json({ zaapId: `Z${this.seq}`, messageId: id, id })
  }
}

/** Entregas de webhook no formato da Z-API (docs-zapi: webhooks/on-message-received-examples, on-whatsapp-message-status-changes). */
export const webhooksZapi = {
  mensagem(sim: ZapiClassica, usuario: string, id: string, texto: string | null, extra: Record<string, unknown> = {}) {
    return { isStatusReply: false, connectedPhone: sim.dono, waitingMessage: false, isEdit: false, isGroup: false, isNewsletter: false, instanceId: sim.instanceId,
      messageId: id, phone: usuario, fromMe: false, momment: Date.now() - 1000, status: 'RECEIVED', chatName: 'Pessoa de teste', senderName: 'Pessoa de teste',
      broadcast: false, type: 'ReceivedCallback', ...(texto === null ? {} : { text: { message: texto } }), ...extra }
  },
  clique: (sim: ZapiClassica, usuario: string, id: string, botaoId: string, titulo: string) => webhooksZapi.mensagem(sim, usuario, id, null,
    { referenceMessageId: 'OUT1', buttonsResponseMessage: { buttonId: botaoId, message: titulo } }),
  estado: (sim: ZapiClassica, usuario: string, id: string, estado: 'RECEIVED' | 'READ') =>
    ({ instanceId: sim.instanceId, status: estado, ids: [id], momment: Date.now() - 1000, phoneDevice: 0, phone: usuario, type: 'MessageStatusCallback', isGroup: false }),
}
