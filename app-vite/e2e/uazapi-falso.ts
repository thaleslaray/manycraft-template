import { createServer, type Server } from "node:http"

/** Servidor UAZAPI falso (docs.uazapi.com v2.6.7): o engine em desenvolvimento aponta para ele (DEV_PROVIDER_API_BASE), então nada sai para o WhatsApp.
 * Imita o que a jornada precisa: status da instância, QR, registro do webhook, envio de texto/menu, marcar como lida e rejeitar ligação.
 * `emitir` faz o papel do servidor entregando um evento no webhook registrado, com o token da instância no corpo (a UAZAPI não assina). */
export type Chamada = { metodo: string; caminho: string; token: string | null; corpo: Record<string, unknown> }
export type UazapiFalso = {
  chamadas: Chamada[]
  /** O webhook que o engine registrou (url e eventos). */
  webhook: () => { url: string; enabled: boolean; events: string[]; excludeMessages: string[] } | undefined
  /** O celular leu o QR: a instância passa a conectada. */
  parear: (nome?: string) => void
  /** Entrega um evento no webhook registrado, como o servidor faria. */
  emitir: (evento: Record<string, unknown>, opcoes?: { token?: string }) => Promise<Response>
  /** Mensagens que o engine mandou (texto ou menu). */
  enviadas: () => { caminho: string; number: string; text: string; corpo: Record<string, unknown> }[]
  fechar: () => Promise<void>
}

export async function subirUazapiFalso(porta: number, config: { token: string; instanciaId: string; dono: string; qr: string; engine: string; grupos?: { JID: string; Name: string }[] }): Promise<UazapiFalso> {
  const chamadas: Chamada[] = []
  let estado: "disconnected" | "connecting" | "connected" = "disconnected"
  let nome: string | undefined
  let enviadas = 0
  const instancia = () => ({ id: config.instanciaId, name: "e2e", status: estado, ...(nome ? { profileName: nome } : {}), ...(estado === "connecting" ? { qrcode: config.qr } : {}) })
  const servidor: Server = createServer((req, res) => {
    const partes: Buffer[] = []
    req.on("data", c => partes.push(c))
    req.on("end", () => {
      const responder = (status: number, json: unknown) => { res.writeHead(status, { "content-type": "application/json", connection: "close" }); res.end(JSON.stringify(json)) }
      const corpo = partes.length ? JSON.parse(Buffer.concat(partes).toString()) : {}
      const caminho = new URL(req.url ?? "/", "http://x").pathname
      const token = (req.headers.token as string | undefined) ?? null
      chamadas.push({ metodo: req.method ?? "GET", caminho, token, corpo })
      if (token !== config.token) return responder(401, { error: "Invalid token" })
      if (caminho === "/instance/status") return responder(200, { instance: instancia(), status: { connected: estado === "connected", loggedIn: estado === "connected" } })
      if (caminho === "/instance/connect") { if (estado !== "connected") estado = "connecting"; return responder(200, { response: "Connecting", instance: instancia() }) }
      if (caminho === "/webhook") return responder(200, [{ id: "wh-e2e", ...corpo }])
      if (caminho === "/send/text" || caminho === "/send/menu") {
        enviadas++
        return responder(200, { id: `${config.dono}:E2E-OUT-${enviadas}`, messageid: `E2E-OUT-${enviadas}`, response: { status: "success" } })
      }
      if (caminho === "/group/list") {
        const busca = String(corpo.search ?? "").toLowerCase()
        const grupos = (config.grupos ?? []).filter(g => g.Name.toLowerCase().includes(busca))
        return responder(200, { groups: grupos, pagination: { totalRecords: grupos.length, limit: 50, offset: 0, hasMore: false, nextOffset: 50 } })
      }
      if (caminho === "/message/markread") return responder(200, { success: true })
      if (caminho === "/call/reject") return responder(200, { response: "Call rejected" })
      return responder(404, { error: "not found" })
    })
  })
  await new Promise<void>((resolve, reject) => { servidor.once("error", reject); servidor.listen(porta, "127.0.0.1", resolve) })
  const webhook = () => chamadas.filter(c => c.caminho === "/webhook").at(-1)?.corpo as ReturnType<UazapiFalso["webhook"]>
  return {
    chamadas, webhook,
    parear: (n = "Loja e2e") => { estado = "connected"; nome = n },
    emitir: async (evento, opcoes = {}) => fetch(webhook()!.url.replace(/^https?:\/\/[^/]+/, config.engine), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: config.dono, instanceName: "e2e", BaseUrl: `http://127.0.0.1:${porta}`, token: opcoes.token ?? config.token, ...evento }),
    }),
    enviadas: () => chamadas.filter(c => c.caminho === "/send/text" || c.caminho === "/send/menu")
      .map(c => ({ caminho: c.caminho, number: String(c.corpo.number), text: String(c.corpo.text), corpo: c.corpo })),
    fechar: () => new Promise<void>(resolve => servidor.close(() => resolve())),
  }
}
