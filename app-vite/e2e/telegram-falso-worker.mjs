import { createServer } from 'node:http'
import { parentPort, workerData } from 'node:worker_threads'

const { porta, bots, chamadasPort } = workerData
let totalChamadas = 0
const registrar = chamada => {
  totalChamadas++
  // The observation enters IPC before the HTTP response, even when the journey is blocked in synchronous D1 work.
  chamadasPort.postMessage(chamada)
}
const servidor = createServer((req, res) => {
  const partes = []
  req.on('data', c => partes.push(c))
  req.on('end', () => {
    const m = /^\/bot([^/]+)\/(\w+)/.exec(req.url ?? '')
    let corpo = {}
    try { corpo = partes.length ? JSON.parse(Buffer.concat(partes).toString()) : {} } catch { /* non-JSON input remains visible as an empty body */ }
    const responder = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify(json))
    }
    // API de terceiros fictícia para a ação de requisição externa: /externo/cliente responde 200 e /externo/erro responde 500.
    const externo = /^\/externo\/([\w-]+)/.exec(req.url ?? '')
    if (externo) {
      registrar({ token: '', metodo: `externo:${req.method}:${externo[1]}`, corpo: { url: req.url, cabecalho: req.headers['x-teste'] ?? null, corpo } })
      return externo[1] === 'cliente' ? responder(200, { data: { plano: 'Premium', pedidos: 3 } }) : responder(500, { error: 'falha simulada' })
    }
    // Graph API do WhatsApp: número consultado com token que contém VALIDO (jornada de Configurações); outros tokens são recusados.
    const wa = /^\/v[\d.]+\/(\d+)(\?|$)/.exec(req.url ?? '')
    if (wa) {
      registrar({ token: '', metodo: 'whatsapp:numero', corpo: {} })
      return /VALIDO/.test(String(req.headers.authorization ?? '')) ? responder(200, { id: wa[1], verified_name: 'Número e2e', display_phone_number: `+${wa[1]}` }) : responder(401, { error: { code: 190, message: 'Invalid OAuth access token' } })
    }
    if (!m) return responder(404, { ok: false })
    const [, token, metodo] = m
    registrar({ token, metodo, corpo })
    // Token com FORA simula o provedor fora do ar (503), diferente de token recusado (401).
    if (/FORA/.test(token)) return responder(503, { ok: false, error_code: 503, description: 'Service Unavailable' })
    const bot = bots[token]
    if (!bot) return responder(401, { ok: false, error_code: 401, description: 'Unauthorized' })
    if (metodo === 'getMe') return responder(200, { ok: true, result: { id: bot.id, is_bot: true, username: bot.username } })
    if (['sendMessage', 'sendPhoto', 'sendAudio', 'sendVideo', 'sendDocument'].includes(metodo)) return responder(200, { ok: true, result: { message_id: 7000 + totalChamadas } })
    if (metodo === 'getUserProfilePhotos') return responder(200, { ok: true, result: { total_count: 0, photos: [] } })
    return responder(200, { ok: true, result: true })
  })
})
servidor.on('error', error => parentPort.postMessage({ tipo: 'erro', codigo: error.code ?? 'FAKE_SERVER_ERROR' }))
servidor.listen(porta, '127.0.0.1', () => parentPort.postMessage({ tipo: 'pronto' }))
parentPort.on('message', mensagem => {
  if (mensagem.tipo !== 'fechar') return
  servidor.close(() => {
    chamadasPort.close()
    parentPort.postMessage({ tipo: 'fechado' })
    parentPort.close()
  })
  servidor.closeAllConnections()
})
