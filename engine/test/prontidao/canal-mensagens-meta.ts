import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { webhooks } from '../../src/integrations'
import type { InboundEvent } from '../../src/integrations'
import { apiJson, filaCapturada, type Canal } from './jornada'
import { assinar, APP_SECRET } from './canal-whatsapp'
import type { SimuladorMensagens } from './simulador-meta-mensagens'

/** Canal Meta de mensagens (Instagram/Messenger): webhook `entry[].messaging[]` assinado, entregue em /meta. */
export function canalMeta(sim: SimuladorMensagens, cfg: { tipo: 'instagram' | 'messenger'; provider: string; objeto: 'instagram' | 'page'; campoConta: 'accountId' | 'pageId'; assinaWebhookSozinho?: boolean }): Canal & { channelId?: string; entregar(corpo: unknown): Promise<{ status: number; eventos: InboundEvent[] }> } {
  const envelope = (messaging: unknown) => ({ object: cfg.objeto, entry: [{ id: sim.contaId, time: Date.now(), messaging: [messaging] }] })
  const c = {
    id: cfg.provider,
    tipo: cfg.tipo,
    channelId: undefined as string | undefined,
    async conectar() {
      // Quem assina o webhook do app sozinho não tem campo de token de verificação: o motor gera um e a conexão já sai ligada.
      const credentials = { accessToken: sim.token, [cfg.campoConta]: sim.contaId, appSecret: APP_SECRET, ...(cfg.assinaWebhookSozinho ? {} : { verifyToken: 'verifica-123' }) }
      const r = await apiJson('POST', 'connections', { kind: cfg.tipo, provider: cfg.provider, credentials }, 201,
        { ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined } as never)
      if (cfg.assinaWebhookSozinho) expect(r.step?.kind, 'webhook do app assinado ao conectar, sem passo manual').toBe('done')
      expect(r.connection.status, cfg.assinaWebhookSozinho ? 'estado logo após conectar (webhook do app assinado e conferido pela Meta)'
        : 'estado logo após conectar (o primeiro webhook ainda não chegou)').toBe(cfg.assinaWebhookSozinho ? 'connected' : 'pending')
      c.channelId = r.connection.id
      return r.connection.id as string
    },
    usuario: (n: number) => String(5500000000000 + n),
    async entregar(corpo: unknown) {
      const fila = filaCapturada()
      const r = await webhooks.request('/meta', await assinar(corpo), fila.bindings as never)
      return { status: r.status, eventos: fila.eventos }
    },
    mensagem: (usuario: string, texto: string, seq: number) => c.entregar(envelope({ sender: { id: usuario }, recipient: { id: sim.contaId }, timestamp: Date.now(), message: { mid: `m_IN${String(seq).padStart(6, '0')}`, text: texto } })),
    clique: (usuario: string, botaoId: string, titulo: string, seq: number) => c.entregar(envelope({ sender: { id: usuario }, recipient: { id: sim.contaId }, timestamp: Date.now(), postback: { mid: `m_PB${String(seq).padStart(6, '0')}`, title: titulo, payload: botaoId } })),
    enviadas: () => sim.enviadas,
  }
  return c
}
