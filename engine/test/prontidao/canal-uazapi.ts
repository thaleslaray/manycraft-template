import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { hooks } from '../../src/channels/core/hooks'
import type { InboundEvent } from '../../src/integrations'
import { apiJson, filaCapturada, type Canal } from './jornada'
import { UAZAPI_SERVER, webhooksUazapi, type Uazapi } from './simulador-uazapi'

export const ctxFalso = { waitUntil: (p: Promise<unknown>) => { void p.catch(() => {}) }, passThroughOnException() {} } as never
const bindings = () => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined }) as never

export function canalUazapi(sim: Uazapi): Canal & { channelId: string; entregar(corpo: unknown, token?: string): Promise<{ status: number; eventos: InboundEvent[] }> } {
  const c: Canal & { channelId: string; entregar(corpo: unknown, token?: string): Promise<{ status: number; eventos: InboundEvent[] }> } = {
    id: 'uazapi', tipo: 'whatsapp', channelId: '',
    async entregar(corpo: unknown, token?: string) {
      const fila = filaCapturada()
      const r = await hooks.request(`/${c.channelId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(token === undefined ? corpo : { ...(corpo as object), token }) }, fila.bindings as never, ctxFalso)
      return { status: r.status, eventos: fila.eventos as InboundEvent[] }
    },
    async conectar() {
      const r = await apiJson('POST', 'connections', { kind: 'whatsapp', provider: 'uazapi', displayName: 'Oficina', credentials: { serverUrl: UAZAPI_SERVER, token: sim.token } }, 201, bindings())
      expect(r.step.kind, 'uma instância nova pede o QR').toBe('qr')
      expect(r.connection.webhook.registered, 'o webhook da UAZAPI deveria ser registrado sozinho').toBe(true)
      expect(sim.webhook, 'o webhook enviado à UAZAPI').toMatchObject({ enabled: true, url: expect.stringContaining(`/api/hooks/${r.connection.id}`) })
      c.channelId = r.connection.id
      sim.parear()   // o usuário lê o QR no celular
      const depois = await apiJson('POST', `connections/${c.channelId}/connect`, undefined, 200, bindings())
      expect(depois.step.kind).toBe('done')
      expect(depois.connection.status).toBe('connected')
      return c.channelId
    },
    usuario: (n: number) => `5511977${String(n).padStart(6, '0')}`,
    mensagem: (u, texto, seq) => c.entregar(webhooksUazapi.mensagem(sim, u, `IN-${seq}`, texto)),
    clique: (u, botaoId, titulo, seq) => c.entregar(webhooksUazapi.clique(sim, u, `IN-${seq}`, botaoId, titulo)),
    enviadas: () => sim.enviadas,
  } satisfies Canal & { channelId: string; entregar: unknown }
  return c as never
}
