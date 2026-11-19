import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { webhooks } from '../../src/integrations'
import { saveBroadcast, consumeBroadcast, getBroadcast } from '../../src/db/broadcasts'
import type { InboundEvent } from '../../src/integrations'
import { apiJson, filaCapturada, type Canal } from './jornada'
import { MetaGraph, webhooksWhatsapp, type ModeloRemoto } from './simuladores'

export const APP_SECRET = 'SEGREDO-APP-SIMULADO'
export async function assinar(corpo: unknown, segredo = APP_SECRET) {
  const texto = JSON.stringify(corpo)
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const assinatura = new Uint8Array(await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(texto)))
  return { method: 'POST', body: texto, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${[...assinatura].map(n => n.toString(16).padStart(2, '0')).join('')}` } }
}

/** Uma conta da Meta que já tem modelos: aprovados, rejeitados, pausados e em análise misturados (como a conta real do coordenador). */
export function contaCheia(): ModeloRemoto[] {
  const corpo = (texto: string, exemplo?: string[]) => ({ type: 'BODY', text: texto, ...(exemplo ? { example: { body_text: [exemplo] } } : {}) })
  const m = (id: string, name: string, status: string, category: string, components: unknown[], extra: Partial<ModeloRemoto> = {}): ModeloRemoto =>
    ({ id, name, language: 'pt_BR', status, category, parameter_format: 'POSITIONAL', components, ...extra })
  return [
    m('101', 'aviso_geral', 'APPROVED', 'UTILITY', [corpo('Passando para avisar que seu pedido está a caminho.')], { quality_score: { score: 'GREEN' } }),
    m('102', 'promo_outubro', 'APPROVED', 'MARKETING', [{ type: 'HEADER', format: 'TEXT', text: 'Oferta' }, corpo('Olá {{1}}, a promoção de outubro chegou.', ['Nara']), { type: 'FOOTER', text: 'Oficina Horizonte' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Quero' }, { type: 'QUICK_REPLY', text: 'Agora não' }] }], { quality_score: { score: 'GREEN' } }),
    m('103', 'lembrete_agenda', 'APPROVED', 'UTILITY', [corpo('Lembrete: sua consulta é amanhã às {{1}}.', ['10h'])], { quality_score: { score: 'YELLOW' } }),
    m('104', 'pos_venda', 'APPROVED', 'MARKETING', [corpo('Obrigado pela compra! Conte como foi.')]),
    m('105', 'cupom_rejeitado', 'REJECTED', 'MARKETING', [corpo('Use o cupom SUPER já!')], { rejected_reason: 'INVALID_FORMAT' }),
    m('106', 'cobranca_rejeitada', 'REJECTED', 'UTILITY', [corpo('Sua conta está em atraso.')], { rejected_reason: 'ABUSIVE_CONTENT' }),
    m('107', 'novidades_pausado', 'PAUSED', 'MARKETING', [corpo('Novidades da semana para você.')], { quality_score: { score: 'RED' } }),
    m('108', 'em_analise', 'PENDING', 'UTILITY', [corpo('Mensagem aguardando revisão.')]),
    m('109', 'apelacao', 'IN_APPEAL', 'UTILITY', [corpo('Mensagem em apelação.')]),
    m('110', 'codigo_acesso', 'APPROVED', 'AUTHENTICATION', [{ type: 'BODY', add_security_recommendation: true }, { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copiar código' }] }]),
  ]
}

export function canalWhatsapp(sim: MetaGraph): Canal & { channelId?: string; entregar(corpo: unknown): Promise<{ status: number; eventos: InboundEvent[] }> } {
  const c = {
    id: 'whatsapp_cloud',
    tipo: 'whatsapp',
    channelId: undefined as string | undefined,
    async conectar() {
      const r = await apiJson('POST', 'connections', { kind: 'whatsapp', credentials: { accessToken: sim.token, phoneNumberId: sim.telefoneId, wabaId: sim.waba, appSecret: APP_SECRET, verifyToken: 'verifica-123' } }, 201,
        { ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined } as never)
      expect(r.connection.status, 'estado logo após conectar (o webhook manual ainda não chegou)').toBe('pending')
      c.channelId = r.connection.id
      return r.connection.id as string
    },
    async sincronizarModelos(id: string) {
      const r = await apiJson<{ imported: number }>('POST', `message-templates/${id}/sync`)
      expect(r.imported, 'quantos modelos da conta da Meta entraram').toBeGreaterThanOrEqual(1)
      const lista = await apiJson<{ name: string; status: string }[]>('GET', `message-templates/${id}`)
      const aprovados = sim.modelos.filter(m => m.status === 'APPROVED' && m.category !== 'AUTHENTICATION').map(m => m.name).sort()
      for (const nome of aprovados) expect(lista.map(t => t.name), `modelo aprovado ${nome} deveria aparecer na lista`).toContain(nome)
    },
    usuario: (n: number) => `BR.USR${String(n).padStart(6, '0')}`,
    async entregar(corpo: unknown) {
      const fila = filaCapturada()
      const r = await webhooks.request('/meta', await assinar(corpo), fila.bindings as never)
      return { status: r.status, eventos: fila.eventos }
    },
    mensagem: (usuario: string, texto: string, seq: number) => c.entregar(webhooksWhatsapp.envelope(sim.telefoneId, [webhooksWhatsapp.texto(usuario, `wamid.IN${String(seq).padStart(6, '0')}`, texto)], [], [webhooksWhatsapp.contato(usuario)])),
    clique: (usuario: string, botaoId: string, titulo: string, seq: number) => c.entregar(webhooksWhatsapp.envelope(sim.telefoneId, [webhooksWhatsapp.clique(usuario, `wamid.IN${String(seq).padStart(6, '0')}`, botaoId, titulo)], [], [webhooksWhatsapp.contato(usuario)])),
    enviadas: () => sim.enviadas,
    async transmissaoComModelo(id: string) {
      const opcoes = await apiJson<{ templates: { id: string; name: string; channel_id: string }[] }>('GET', 'broadcasts/options')
      const modelo = opcoes.templates.find(t => t.name === 'aviso_geral')
      expect(modelo, 'o modelo aprovado e sem variáveis deveria estar disponível na transmissão').toBeTruthy()
      await new Promise(r => setTimeout(r, 1200))   // o limitador deixa 1 mensagem por segundo por conversa
      const antes = sim.enviadas.length
      const local = { ...env, INBOUND: { send: async () => {} } as unknown as Queue }
      const principal = { userId: 'test-owner', workspaceId: 'a', role: 'owner' as const }
      const b = await saveBroadcast(local as never, principal, { name: 'Aviso com modelo', content: '', status: 'sending', audience: { tag: 'all', channel: 'whatsapp', channel_id: id }, template: { id: modelo!.id, params: {} } } as never)
      const mensagem = { body: { kind: 'broadcast', workspaceId: 'a', broadcastId: b.id }, ack: () => {}, retry: () => { throw new Error('a transmissão pediu nova tentativa') } }
      await consumeBroadcast(mensagem as never, local as never)
      const final = await getBroadcast(local as never, principal, b.id)
      expect(final.metrics, 'métricas da transmissão: ' + JSON.stringify({ status: (final as any).status, recipients: (final as any).recipients, chamadas: sim.chamadas.length })).toMatchObject({ sent: 1 })
      const nova = sim.enviadas.slice(antes)
      expect(nova).toHaveLength(1)
      expect(nova[0].modelo).toMatchObject({ nome: 'aviso_geral', idioma: 'pt_BR' })
      expect(nova[0].texto).toBe('Passando para avisar que seu pedido está a caminho.')
    },
  }
  return c
}
