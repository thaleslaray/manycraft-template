import { createServer, type Server } from "node:http"

/** Servidor Z-API falso (api.z-api.io, API clássica de instâncias): o engine em desenvolvimento aponta para ele (DEV_PROVIDER_API_BASE),
 * então nada sai para o WhatsApp. Imita o que a jornada precisa: status e QR da instância, os PUT de webhook, o envio de mensagens.
 * `emitir` faz o papel da Z-API entregando um evento na URL de webhook que o engine registrou (a Z-API não assina nem manda cabeçalho:
 * o segredo vai na própria URL, como o engine a registrou). */
export type Chamada = { metodo: string; rota: string; clientToken: string | null; corpo: Record<string, unknown> }
export type ZapiFalso = {
  chamadas: Chamada[]
  /** A URL que o engine registrou em "Ao receber" (com o segredo na query), ou undefined se ainda não registrou. */
  webhook: () => string | undefined
  /** Valor atual de "notificar as enviadas por mim". */
  notificaEnviadasPorMim: () => boolean
  /** O celular leu o QR: a instância passa a conectada. */
  parear: () => void
  /** Entrega um evento na URL registrada, como a Z-API faria. `segredo` troca o segredo da query (para provar a recusa). */
  emitir: (evento: unknown, opcoes?: { segredo?: string | null }) => Promise<Response>
  /** Mensagens que o engine mandou. */
  enviadas: () => { telefone: string; rota: string; corpo: Record<string, unknown> }[]
  fechar: () => Promise<void>
}

export async function subirZapiFalso(porta: number, config: { instancia: string; token: string; clientToken: string; qr: string; engine: string }): Promise<ZapiFalso> {
  const chamadas: Chamada[] = []
  let pareado = false, enviadasN = 0, enviadasPorMim = false
  const webhooks = new Map<string, string>()
  const base = `/instances/${config.instancia}/token/${config.token}`
  const servidor: Server = createServer((req, res) => {
    const partes: Buffer[] = []
    req.on("data", c => partes.push(c))
    req.on("end", () => {
      const responder = (status: number, json?: unknown) => { res.writeHead(status, { "content-type": "application/json", connection: "close" }); res.end(json === undefined ? undefined : JSON.stringify(json)) }
      const corpo = partes.length ? JSON.parse(Buffer.concat(partes).toString()) : {}
      const caminho = new URL(req.url ?? "/", "http://x").pathname
      const clientToken = (req.headers["client-token"] as string | undefined) ?? null
      const rota = caminho.startsWith(base) ? caminho.slice(base.length) : caminho
      chamadas.push({ metodo: req.method ?? "GET", rota, clientToken, corpo })
      if (clientToken !== config.clientToken) return responder(401, { error: "null not allowed" })
      if (!caminho.startsWith(base)) return responder(404, { error: "Instance not found" })
      if (rota === "/status") return responder(200, { connected: pareado, error: pareado ? "You are already connected" : "You are not connected", smartphoneConnected: pareado })
      if (rota === "/qr-code") return responder(200, { value: config.qr })
      if (req.method === "PUT" && rota.startsWith("/update-webhook-")) { webhooks.set(rota.slice("/update-webhook-".length), String(corpo.value)); return responder(200, { value: true }) }
      if (req.method === "PUT" && rota === "/update-notify-sent-by-me") { enviadasPorMim = corpo.notifySentByMe === true; return responder(200, { value: true }) }
      if (req.method === "PUT" && rota === "/update-queue-settings") return responder(200, { value: true })
      if (req.method === "POST" && /^\/send-(text|button-list|button-actions)$/.test(rota)) { enviadasN++; const id = `E2EOUT${enviadasN}`.padEnd(32, "0"); return responder(200, { zaapId: `Z${enviadasN}`, messageId: id, id }) }
      return responder(404, { error: "not found" })
    })
  })
  await new Promise<void>((resolve, reject) => { servidor.once("error", reject); servidor.listen(porta, "127.0.0.1", resolve) })
  const webhook = () => webhooks.get("received")
  return {
    chamadas, webhook,
    notificaEnviadasPorMim: () => enviadasPorMim,
    parear: () => { pareado = true },
    emitir: async (evento, opcoes = {}) => {
      const url = new URL(webhook()!)
      if (opcoes.segredo === null) url.searchParams.delete("k")
      else if (opcoes.segredo !== undefined) url.searchParams.set("k", opcoes.segredo)
      return fetch(`${config.engine}${url.pathname}${url.search}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(evento) })
    },
    enviadas: () => chamadas.filter(c => c.metodo === "POST" && c.rota.startsWith("/send-")).map(c => ({ telefone: String(c.corpo.phone), rota: c.rota, corpo: c.corpo })),
    fechar: () => new Promise<void>(resolve => servidor.close(() => resolve())),
  }
}
