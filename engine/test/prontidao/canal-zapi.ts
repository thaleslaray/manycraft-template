import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { hooks } from '../../src/channels/core/hooks'
import type { InboundEvent } from '../../src/integrations'
import { apiJson, filaCapturada, type Canal } from './jornada'
import { ctxFalso } from './canal-uazapi'
import { webhooksZapi, type ZapiClassica } from './simulador-zapi'

const bindings = () => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined }) as never

export function canalZapi(sim: ZapiClassica): Canal & { channelId: string; entregar(corpo: unknown, segredo?: string): Promise<{ status: number; eventos: InboundEvent[] }> } {
  const c = {
    id: 'zapi', tipo: 'whatsapp', channelId: '',
    /** A Z-API não assina nem manda cabeçalho: o segredo vai na query da URL registrada. */
    async entregar(corpo: unknown, segredo = sim.segredoDoHook) {
      const fila = filaCapturada()
      const r = await hooks.request(`/${c.channelId}?k=${encodeURIComponent(segredo)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) }, fila.bindings as never, ctxFalso)
      return { status: r.status, eventos: fila.eventos as InboundEvent[] }
    },
    async conectar() {
      const r = await apiJson('POST', 'connections', { kind: 'whatsapp', provider: 'zapi', displayName: 'Oficina',
        credentials: { instanceId: sim.instanceId, token: sim.token, clientToken: sim.clientToken } }, 201, bindings())
      expect(r.step.kind, 'um canal novo pede o QR').toBe('qr')
      expect(r.connection.webhook.registered, 'os webhooks da Z-API deveriam ser registrados sozinhos').toBe(true)
      expect(sim.segredoDoHook, 'a Z-API deveria ter recebido a URL com o segredo').not.toBe('')
      expect(sim.notificaEnviadasPorMim, 'o dono pelo celular só chega com "notificar enviadas por mim"').toBe(true)
      c.channelId = r.connection.id
      sim.parear()   // o usuário lê o QR no celular
      const depois = await apiJson('POST', `connections/${c.channelId}/connect`, undefined, 200, bindings())
      expect(depois.step.kind).toBe('done')
      expect(depois.connection.status).toBe('connected')
      return c.channelId
    },
    usuario: (n: number) => `5511966${String(n).padStart(6, '0')}`,
    mensagem: (u: string, texto: string, seq: number) => c.entregar(webhooksZapi.mensagem(sim, u, `IN${String(seq).padStart(30, '0')}`, texto)),
    clique: (u: string, botaoId: string, titulo: string, seq: number) => c.entregar(webhooksZapi.clique(sim, u, `IN${String(seq).padStart(30, '0')}`, botaoId, titulo)),
    enviadas: () => sim.enviadas,
  }
  return c as never
}
