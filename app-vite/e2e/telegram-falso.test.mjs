import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Worker } from 'node:worker_threads'
import test from 'node:test'
import { subirTelegramFalso } from './telegram-falso.ts'

async function portaLivre() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('Telegram falso responde getMe e sendMessage enquanto a thread da jornada está bloqueada', { timeout: 10_000 }, async () => {
  const porta = await portaLivre()
  const falso = await subirTelegramFalso(porta, { LOCALONLY: { id: 123, username: 'local_bot' } })
  const memoria = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
  const sinal = new Int32Array(memoria)
  const cliente = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads')
    const sinal = new Int32Array(workerData.memoria)
    parentPort.postMessage('pronto')
    Atomics.wait(sinal, 0, 0)
    ;(async () => {
      try {
        const base = 'http://127.0.0.1:' + workerData.porta + '/botLOCALONLY/'
        const me = await (await fetch(base + 'getMe')).json()
        const send = await (await fetch(base + 'sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: 'contato-local', text: 'Resposta local' }) })).json()
        Atomics.store(sinal, 1, me.ok && me.result.username === 'local_bot' && send.ok && send.result.message_id > 0 ? 1 : -1)
      } catch { Atomics.store(sinal, 1, -1) }
      Atomics.notify(sinal, 1)
    })()
  `, { eval: true, workerData: { porta, memoria } })
  try {
    assert.deepEqual(await once(cliente, 'message'), ['pronto'])
    Atomics.store(sinal, 0, 1)
    Atomics.notify(sinal, 0)
    const espera = Atomics.wait(sinal, 1, 0, 3000)
    assert.notEqual(espera, 'timed-out', 'a API falsa precisa atender mesmo durante consulta D1 síncrona na thread principal')
    assert.equal(Atomics.load(sinal, 1), 1)
    // The public getter drains IPC synchronously, before the main event loop can process listeners.
    assert.deepEqual(falso.enviadas(), [{ token: 'LOCALONLY', chat_id: 'contato-local', text: 'Resposta local' }])
  } finally {
    await cliente.terminate()
    await falso.fechar()
  }
})

test('preserva registros, webhook e fotos; fechar libera a porta', async () => {
  const porta = await portaLivre()
  const falso = await subirTelegramFalso(porta, { LOCALONLY: { id: 123, username: 'local_bot' } })
  const base = `http://127.0.0.1:${porta}`
  const chamadas = falso.chamadas
  try {
    const webhook = { url: 'http://127.0.0.1:1/webhook-local', secret_token: 'SEGREDO-APENAS-FALSO' }
    const resposta = await fetch(`${base}/botLOCALONLY/setWebhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(webhook),
    })
    assert.equal(resposta.headers.get('connection'), 'close')
    assert.deepEqual(await resposta.json(), { ok: true, result: true })
    assert.deepEqual(falso.webhook(), webhook)
    assert.equal(falso.chamadas, chamadas)
    assert.deepEqual(chamadas[0], { token: 'LOCALONLY', metodo: 'setWebhook', corpo: webhook })
    assert.deepEqual(await (await fetch(`${base}/botLOCALONLY/getUserProfilePhotos`)).json(), { ok: true, result: { total_count: 0, photos: [] } })
    assert.equal((await fetch(`${base}/botINVALIDO/getMe`)).status, 401)
    assert.equal((await fetch(`${base}/rota-ausente`)).status, 404)
  } finally {
    await Promise.all([falso.fechar(), falso.fechar()])
  }
  const novamente = await subirTelegramFalso(porta, {})
  await novamente.fechar()
})

test('propaga erro de bind sem deixar Worker pendente', async () => {
  const ocupado = createServer()
  ocupado.listen(0, '127.0.0.1')
  await once(ocupado, 'listening')
  try {
    await assert.rejects(subirTelegramFalso(ocupado.address().port, {}), /EADDRINUSE/)
  } finally {
    await new Promise(resolve => ocupado.close(resolve))
  }
})

test('envio de token desconhecido fica no diagnóstico e não conta como mensagem enviada', async () => {
  const porta = await portaLivre()
  const falso = await subirTelegramFalso(porta, { LOCALONLY: { id: 123, username: 'local_bot' } })
  const corpo = { chat_id: 'contato-local', text: 'Tentativa rejeitada' }
  try {
    const resposta = await fetch(`http://127.0.0.1:${porta}/botANTIGO/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo),
    })
    assert.equal(resposta.status, 401)
    assert.deepEqual(falso.chamadas, [{ token: 'ANTIGO', metodo: 'sendMessage', corpo }])
    assert.deepEqual(falso.enviadas(), [])
  } finally {
    await falso.fechar()
  }
})
