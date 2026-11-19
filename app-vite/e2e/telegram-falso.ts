import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads"

/** API de bots falsa: o engine em desenvolvimento aponta para ela (DEV_PROVIDER_API_BASE), então nada sai para o Telegram de verdade. */
export type TelegramFalso = {
  /** Corpo do último setWebhook recebido (url e secret_token que o Telegram devolveria em cada entrega). */
  webhook: () => { url: string; secret_token: string } | undefined
  chamadas: { token: string; metodo: string; corpo: Record<string, unknown> }[]
  /** Instante (ms) em que cada chamada de `chamadas` chegou ao processo de teste, na mesma ordem. */
  instantes: number[]
  enviadas: () => { token: string; chat_id: string; text: string }[]
  fechar: () => Promise<void>
}

export async function subirTelegramFalso(porta: number, bots: Record<string, { id: number; username: string }>): Promise<TelegramFalso> {
  const chamadas: TelegramFalso["chamadas"] = []
  const instantes: number[] = []
  const { port1, port2 } = new MessageChannel()
  const servidor = new Worker(new URL("./telegram-falso-worker.mjs", import.meta.url), {
    workerData: { porta, bots, chamadasPort: port2 }, transferList: [port2],
  })
  let erro: Error | undefined
  let fechando: Promise<void> | undefined
  const registrar = (chamada: TelegramFalso["chamadas"][number]) => { instantes.push(Date.now()); return chamadas.push(chamada) }
  port1.on("message", registrar)
  const observar = () => {
    // A synchronous query can block message listeners. Getters drain queued observations before returning the shared array.
    for (let item = receiveMessageOnPort(port1); item; item = receiveMessageOnPort(port1)) registrar(item.message)
    if (erro) throw erro
    return chamadas
  }
  try {
    await new Promise<void>((resolve, reject) => {
      servidor.on("message", (mensagem: { tipo: string; codigo?: string }) => {
        if (mensagem.tipo === "pronto") resolve()
        if (mensagem.tipo === "erro") {
          erro = new Error(`Servidor falso indisponível (${mensagem.codigo}).`)
          reject(erro)
        }
      })
      servidor.on("error", causa => { erro = causa instanceof Error ? causa : new Error("Falha no Worker do servidor falso."); reject(erro) })
      servidor.on("exit", codigo => {
        if (!fechando) { erro ??= new Error(`Servidor falso encerrou (${codigo}).`); reject(erro) }
      })
    })
  } catch (causa) {
    port1.close()
    await servidor.terminate()
    throw causa
  }
  return {
    get chamadas() { return observar() },
    get instantes() { observar(); return instantes },
    webhook: () => observar().filter(c => c.metodo === "setWebhook").at(-1)?.corpo as { url: string; secret_token: string } | undefined,
    enviadas: () => observar().filter(c => c.metodo === "sendMessage" && Object.hasOwn(bots, c.token)).map(c => ({ token: c.token, chat_id: String(c.corpo.chat_id), text: String(c.corpo.text) })),
    fechar: () => fechando ??= (async () => {
      try {
        if (servidor.threadId !== -1) await new Promise<void>(resolve => {
          const concluido = () => { servidor.off("message", mensagem); servidor.off("exit", concluido); resolve() }
          const mensagem = (evento: { tipo: string }) => { if (evento.tipo === "fechado") concluido() }
          servidor.on("message", mensagem)
          servidor.once("exit", concluido)
          servidor.postMessage({ tipo: "fechar" })
        })
      } finally {
        await servidor.terminate()
        port1.close()
      }
    })(),
  }
}
