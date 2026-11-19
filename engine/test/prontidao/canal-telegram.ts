import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { hooks } from '../../src/channels/core/hooks'
import type { InboundEvent } from '../../src/integrations'
import { apiJson, filaCapturada, type Canal } from './jornada'
import type { TelegramBot } from './simuladores'

export function canalTelegram(sim: TelegramBot): Canal {
  let channelId = ''
  const entregar = async (update: unknown) => {
    const fila = filaCapturada()
    const r = await hooks.request(`/${channelId}`, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': sim.segredoWebhook, 'content-type': 'application/json' }, body: JSON.stringify(update) }, fila.bindings as never, { waitUntil: (p: Promise<unknown>) => { void p.catch(() => {}) }, passThroughOnException() {} } as never)
    return { status: r.status, eventos: fila.eventos as InboundEvent[] }
  }
  const c: Canal = {
    id: 'telegram', tipo: 'telegram',
    async conectar() {
      const r = await apiJson('POST', 'connections', { kind: 'telegram', credentials: { botToken: sim.token } }, 201, { ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined } as never)
      expect(r.connection.status).toBe('connected')
      expect(r.connection.webhook.registered, 'o webhook do Telegram deveria ser registrado sozinho').toBe(true)
      channelId = r.connection.id
      return channelId
    },
    usuario: n => String(5000 + n),
    mensagem: (u, texto, seq) => entregar({ update_id: seq, message: { message_id: seq, from: { id: Number(u), first_name: 'Pessoa de teste' }, chat: { id: Number(u), type: 'private' }, text: texto, date: Math.floor(Date.now() / 1000) } }),
    clique: (u, botaoId, _t, seq) => entregar({ update_id: seq, callback_query: { id: `cb-${seq}`, from: { id: Number(u) }, data: botaoId, message: { message_id: 1, chat: { id: Number(u), type: 'private' } } } }),
    enviadas: () => sim.enviadas,
  }
  return c
}
