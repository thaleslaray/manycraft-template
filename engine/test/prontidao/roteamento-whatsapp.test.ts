/**
 * WhatsApp oficial com mais de um parceiro no número (Conversation Routing) e conversa iniciada pela caixa de entrada.
 * Formatos: https://developers.facebook.com/documentation/business-messaging/whatsapp/conversation-routing/thread-control
 *           https://developers.facebook.com/documentation/business-messaging/whatsapp/conversation-routing/routing-roles
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import { metaWhatsappCloud } from '../../src/channels/meta-whatsapp-cloud'
import { failureNotice } from '../../src/channels/core/failure'
import { connectionFromRow, liteRow } from '../../src/channels/core/connection'
import { canalWhatsapp, contaCheia } from './canal-whatsapp'
import { api, apiJson, consumir, prepararEspaco, sql } from './jornada'
import { instalarRede, MetaGraph, webhooksWhatsapp } from './simuladores'

const USUARIO = 'BR.USR000001'
let sim: MetaGraph, canal: ReturnType<typeof canalWhatsapp>, canalId: string
beforeEach(async () => {
  await prepararEspaco()
  sim = new MetaGraph()
  sim.modelos = contaCheia()
  instalarRede(sim)
  canal = canalWhatsapp(sim)
  canalId = await canal.conectar()
  await env.DB.prepare("UPDATE channels SET connection_state='connected' WHERE id=?").bind(canalId).run()
})
afterEach(() => vi.restoreAllMocks())

describe('Conversation Routing: webhook messaging_handovers', () => {
  const dono = (usuario = USUARIO) => sql.um<{ owner_role: string | null; previous_role: string | null }>(
    "SELECT owner_role,previous_role FROM whatsapp_thread_owners WHERE workspace_id='a' AND channel_id=? AND external_user_id=?", canalId, usuario)

  it('aceita a troca de dono e guarda quem é o dono agora', async () => {
    const r = await canal.entregar(webhooksWhatsapp.troca(sim.telefoneId, USUARIO, 'control_passed', 'ai_agent', 'customer_service'))
    expect(r.status).toBe(200)
    expect(r.eventos).toHaveLength(1)
    await consumir(r.eventos)
    expect(await dono()).toEqual({ owner_role: 'customer_service', previous_role: 'ai_agent' })
  })
  it('control_taken também troca o dono, e um aviso atrasado não desfaz o mais novo', async () => {
    const agora = Math.floor(Date.now() / 1000)
    const novo = await canal.entregar(webhooksWhatsapp.troca(sim.telefoneId, USUARIO, 'control_taken', 'customer_service', 'escalation', agora))
    await consumir(novo.eventos)
    const velho = await canal.entregar(webhooksWhatsapp.troca(sim.telefoneId, USUARIO, 'control_passed', 'ai_agent', 'customer_service', agora - 600))
    await consumir(velho.eventos)
    expect(await dono()).toEqual({ owner_role: 'escalation', previous_role: 'customer_service' })
  })
  it('cópia de standby (conversa de outro parceiro) é aceita e ignorada: não dispara fluxo nem cria contato', async () => {
    const corpo = webhooksWhatsapp.envelope(sim.telefoneId, [webhooksWhatsapp.texto(USUARIO, 'wamid.INSTANDBY1', 'quero')], [], [webhooksWhatsapp.contato(USUARIO)])
    corpo.entry[0].changes[0].field = 'standby'
    const r = await canal.entregar(corpo)
    expect(r.status).toBe(200)
    expect(r.eventos, 'a cópia de uma conversa que não é nossa não vai para a fila').toHaveLength(0)
  })
  it('o mesmo aviso entregue duas vezes não muda nada', async () => {
    const corpo = webhooksWhatsapp.troca(sim.telefoneId, USUARIO, 'control_passed', 'marketing', 'utility')
    await consumir((await canal.entregar(corpo)).eventos)
    await consumir((await canal.entregar(corpo)).eventos)
    expect(await sql.n("SELECT count(*) n FROM whatsapp_thread_owners WHERE channel_id=?", canalId)).toBe(1)
  })
})

describe('Conversation Routing: papéis e controle da conversa', () => {
  beforeEach(() => { sim.roteamento = { ativo: true, papeis: ['customer_service'], standby: false } })

  it('GET routing_roles: o app mostra os nossos papéis', async () => {
    sim.roteamento.papeis = ['customer_service', 'escalation']
    const r = await apiJson<{ active: boolean; roles: string[]; standby: boolean }>('GET', `connections/${canalId}/routing`)
    expect(r).toEqual({ active: true, roles: ['customer_service', 'escalation'], standby: false })
    expect(sim.chamadas.some(c => c.caminho.endsWith(`/${sim.telefoneId}/routing_roles`) && c.metodo === 'GET')).toBe(true)
  })
  it('número sem Conversation Routing: não é erro, só informa que não está ativo', async () => {
    sim.roteamento = { ativo: false, papeis: [], standby: false }
    expect(await apiJson('GET', `connections/${canalId}/routing`)).toEqual({ active: false, roles: [], standby: false })
  })
  it('conexão que não é da API oficial não tem papéis', async () => {
    await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state) VALUES ('tg-x','a','telegram','telegram_bot','1','connected')").run()
    expect(await apiJson('GET', 'connections/tg-x/routing')).toEqual({ active: false, roles: [], standby: false })
  })

  const controlar = (corpo: Record<string, unknown>, esperado = 200) => apiJson<any>('POST', `connections/${canalId}/thread-control`, { external_user_id: USUARIO, ...corpo }, esperado)
  const enviado = () => sim.chamadas.filter(c => c.caminho.endsWith('/thread_control')).at(-1)!.corpo as any

  it('pass sem alvo vai para o parceiro de escalonamento e guarda o novo dono', async () => {
    sim.donos.set(USUARIO, 'customer_service')
    const r = await controlar({ action: 'pass' })
    expect(r.request_id).toMatch(/^req\./)
    expect(enviado()).toEqual({ messaging_product: 'whatsapp', recipient: USUARIO, action: 'pass' })
    expect(await sql.um("SELECT owner_role o FROM whatsapp_thread_owners WHERE channel_id=? AND external_user_id=?", canalId, USUARIO)).toEqual({ o: 'escalation' })
  })
  it('pass com alvo manda control_pass.target_role e metadata', async () => {
    sim.donos.set(USUARIO, 'customer_service')
    await controlar({ action: 'pass', target_role: 'marketing', metadata: 'cliente pediu promoção' })
    expect(enviado()).toEqual({ messaging_product: 'whatsapp', recipient: USUARIO, action: 'pass', control_pass: { target_role: 'marketing' }, metadata: 'cliente pediu promoção' })
  })
  it('telefone vai em `to`, nunca os dois juntos', async () => {
    sim.donos.set('5511999990000', 'customer_service')
    await apiJson('POST', `connections/${canalId}/thread-control`, { external_user_id: '5511999990000', action: 'release' })
    expect(enviado()).toEqual({ messaging_product: 'whatsapp', to: '5511999990000', action: 'release' })
  })
  it('release devolve a conversa ao estado ocioso', async () => {
    sim.donos.set(USUARIO, 'customer_service')
    await controlar({ action: 'release' })
    expect(sim.donos.get(USUARIO)).toBeNull()
    expect(await sql.um("SELECT owner_role o FROM whatsapp_thread_owners WHERE channel_id=? AND external_user_id=?", canalId, USUARIO)).toEqual({ o: null })
  })
  it('take só para o parceiro de escalonamento: sem o papel, nem chama a Meta', async () => {
    const antes = sim.chamadas.length
    const r = await api('POST', `connections/${canalId}/thread-control`, { external_user_id: USUARIO, action: 'take' })
    expect(r.status).toBe(409)
    expect((await r.json() as any).error ?? (await r.clone().text())).toMatch(/escalonamento/i)
    expect(sim.chamadas.slice(antes).some(c => c.caminho.endsWith('/thread_control'))).toBe(false)
  })
  it('take com o papel de escalonamento assume a conversa de qualquer dono', async () => {
    sim.roteamento.papeis = ['escalation']
    sim.donos.set(USUARIO, 'marketing')
    await controlar({ action: 'take' })
    expect(sim.donos.get(USUARIO)).toBe('escalation')
  })
  it('erro da Meta chega em português, sem vazar o corpo cru', async () => {
    const r = await api('POST', `connections/${canalId}/thread-control`, { external_user_id: USUARIO, action: 'release' })   // sim: conversa ociosa, não é nossa
    expect(r.status).toBe(409)
    expect(await r.text()).toMatch(/Conversation routing|não é dono|não controla/i)
  })
  it('valida o corpo: ação desconhecida, alvo fora da lista e take com alvo', async () => {
    for (const corpo of [{ action: 'give' }, { action: 'pass', target_role: 'chefe' }, { action: 'take', target_role: 'marketing' }, { action: 'pass', metadata: 'x'.repeat(2001) }])
      expect((await api('POST', `connections/${canalId}/thread-control`, { external_user_id: USUARIO, ...corpo })).status, JSON.stringify(corpo)).toBe(400)
  })
})

describe('erro 131070 (outra app controla a conversa)', () => {
  it('a Meta recusa o envio e o app explica em português com o caminho no Gerenciador de Negócios', async () => {
    sim.roteamento = { ativo: true, papeis: ['marketing'], standby: false }
    const connection = connectionFromRow({ ...liteRow('whatsapp', canalId, 'a'), provider: 'meta_whatsapp_cloud', external_id: sim.telefoneId })
    const resultado = await metaWhatsappCloud.send({ connection, credentials: { accessToken: sim.token, phoneNumberId: sim.telefoneId }, fetch: globalThis.fetch,
      target: { kind: 'direct', externalUserId: USUARIO } }, { kind: 'text', text: 'oi' })
    expect(resultado).toMatchObject({ ok: false, reason: 'rejected', code: '131070' })
    const aviso = failureNotice(resultado)!
    expect(aviso).toContain('Gerenciador de Negócios')
    expect(aviso).toContain('Conversation routing')
    expect(aviso).toMatch(/outro app|outro parceiro/i)
  })
})

describe('iniciar conversa com número novo pela caixa de entrada', () => {
  const NOVO = '+55 (11) 99999-0001'
  const iniciar = (corpo: Record<string, unknown> = {}, esperado = 201) => {
    return apiJson<any>('POST', 'inbox/conversations', { connection_id: canalId, phone: NOVO, name: 'Nara Souza', consent: true, template: { id: '', params: {} }, ...corpo }, esperado)
  }
  async function modeloLocal() {
    await canal.sincronizarModelos!(canalId)
    const lista = await apiJson<{ id: string; name: string }[]>('GET', `message-templates/${canalId}`)
    return lista.find(t => t.name === 'aviso_geral')!.id
  }

  it('manda o modelo aprovado para o telefone (campo `to`), cria o contato e abre a conversa', async () => {
    const id = await modeloLocal()
    const r = await iniciar({ template: { id, params: {} } })
    expect(r.message).toMatchObject({ direction: 'out', sender: 'human', status: 'sent' })
    expect(r.conversation.contact.name).toBe('Nara Souza')
    const chamada = sim.chamadas.filter(c => c.caminho.endsWith('/messages')).at(-1)!.corpo as any
    expect(chamada).toMatchObject({ messaging_product: 'whatsapp', to: '5511999990001', type: 'template', template: { name: 'aviso_geral', language: { code: 'pt_BR' } } })
    expect(chamada.recipient).toBeUndefined()
    expect(sim.enviadas.at(-1)).toMatchObject({ para: '5511999990001', texto: 'Passando para avisar que seu pedido está a caminho.' })
    expect(await sql.um("SELECT opted_in,identity_kind FROM contact_channels WHERE channel_id=? AND external_user_id='5511999990001'", canalId)).toEqual({ opted_in: 1, identity_kind: 'wa_phone_legacy' })
  })
  it('repetir para o mesmo número reaproveita contato e conversa', async () => {
    const id = await modeloLocal()
    const a = await iniciar({ template: { id, params: {} } })
    await new Promise(r => setTimeout(r, 1100))
    const b = await iniciar({ template: { id, params: {} } })
    expect(b.conversation.id).toBe(a.conversation.id)
    expect(await sql.n("SELECT count(*) n FROM contact_channels WHERE channel_id=?", canalId)).toBe(1)
  })
  it('exige a confirmação de consentimento: sem ela nada é enviado', async () => {
    const id = await modeloLocal()
    const antes = sim.enviadas.length
    await iniciar({ template: { id, params: {} }, consent: false }, 400)
    await iniciar({ template: { id, params: {} }, consent: undefined }, 400)
    expect(sim.enviadas.length).toBe(antes)
    expect(await sql.n("SELECT count(*) n FROM contact_channels WHERE channel_id=?", canalId)).toBe(0)
  })
  it.each(['abc', '123', '+0011999', '55119999900011111111'])('recusa telefone inválido: %s', async phone => {
    const id = await modeloLocal()
    await iniciar({ template: { id, params: {} }, phone }, 400)
  })
  it('modelo que não é desta conexão ou não está aprovado dá 404 e não envia', async () => {
    await modeloLocal()
    const antes = sim.enviadas.length
    await iniciar({ template: { id: 'nao-existe', params: {} } }, 404)
    expect(sim.enviadas.length).toBe(antes)
  })
  it('só a API oficial do WhatsApp inicia conversa assim', async () => {
    await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state) VALUES ('tg-x','a','telegram','telegram_bot','1','connected')").run()
    await iniciar({ connection_id: 'tg-x', template: { id: 'x', params: {} } }, 409)
  })
  it('o contato responde: a resposta cai na mesma conversa, com o mesmo contato', async () => {
    const id = await modeloLocal()
    const a = await iniciar({ template: { id, params: {} } })
    const r = await canal.entregar(webhooksWhatsapp.envelope(sim.telefoneId, [{ ...webhooksWhatsapp.texto('BR.NARA000001', 'wamid.INRESP01', 'Oi, recebi!'), from: '5511999990001' }], [],
      [{ profile: { name: 'Nara Souza' }, wa_id: '5511999990001', user_id: 'BR.NARA000001' }]))
    await consumir(r.eventos)
    const mensagens = await apiJson<{ rows: { text: string; direction: string }[] }>('GET', `inbox/conversations/${a.conversation.id}/messages`)
    expect(mensagens.rows.map(m => m.text)).toContain('Oi, recebi!')
    expect(await sql.n("SELECT count(*) n FROM contact_channels WHERE channel_id=?", canalId), 'a mesma linha é promovida a BSUID, sem duplicar').toBe(1)
    expect(await sql.um("SELECT external_user_id,identity_kind,phone_e164 FROM contact_channels WHERE channel_id=?", canalId)).toEqual({ external_user_id: 'BR.NARA000001', identity_kind: 'bsuid', phone_e164: '+5511999990001' })
    expect(await sql.n("SELECT count(*) n FROM conversations WHERE workspace_id='a'")).toBe(1)
  })
})
