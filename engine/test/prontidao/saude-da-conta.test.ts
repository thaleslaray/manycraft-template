/**
 * Saúde da conta do WhatsApp oficial: descadastro do contato (user_preferences), qualidade e limites do número, alertas, restrições,
 * revisão da conta e status/qualidade de modelo, todos vindos pelos webhooks. Os corpos são os exemplos oficiais da Meta
 * (replica/contratos/meta-whatsapp/exemplos/webhooks) com os marcadores trocados pelos ids da conta simulada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import { saveBroadcast, consumeBroadcast, getBroadcast } from '../../src/db/broadcasts'
import { APP_SECRET, canalWhatsapp, contaCheia } from './canal-whatsapp'
import { api, apiJson, consumir, prepararEspaco, sql } from './jornada'
import { instalarRede, MetaGraph } from './simuladores'
import { giveCredentials } from '../credentials'
import preferenciaParar from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/user_preferences-parar-marketing.json'
import qualidade from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/phone_number_quality_update-upgrade-de-throughput.json'
import limites from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/business_capability_update-limites.json'
import alerta from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/account_alerts-aumento-de-limite-negado.json'
import revisao from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/account_review_update-aprovada.json'
import restricao from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/account_update-conta-restrita.json'
import violacao from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/account_update-violacao.json'
import desabilitada from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/account_update-desabilitada.json'
import excluida from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/account_update-conta-excluida.json'
import reconectada from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/account_update-conta-reconectada.json'
import modeloAprovado from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/message_template_status_update-aprovado.json'
import modeloRejeitado from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/message_template_status_update-rejeitado.json'
import categoriaAlterada from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/template_category_update-categoria-alterada.json'
import categoriaAviso from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/template_category_update-aviso-de-recategorizacao.json'
import modeloQualidade from '../../../replica/contratos/meta-whatsapp/exemplos/webhooks/message_template_quality_update-mudanca.json'

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

/** O exemplo oficial com os marcadores trocados pelos ids da conta simulada. */
function exemplo(corpo: unknown, extra: Record<string, string> = {}) {
  const { _fonte, ...resto } = corpo as { _fonte: unknown }
  const trocas: Record<string, string> = { '<WABA_ID>': sim.waba, '<PHONE_NUMBER_ID>': sim.telefoneId, '<BSUID>': USUARIO, '<PARENT_BSUID>': 'BR.ENT.PAI000001',
    '<WA_ID>': '5511900000001', '<BUSINESS_DISPLAY_PHONE>': '551140000000', ...extra }
  return JSON.parse(Object.entries(trocas).reduce((texto, [de, para]) => texto.replaceAll(de, para), JSON.stringify(resto)))
}
const preferencia = (valor: 'stop' | 'resume', em = Math.floor(Date.now() / 1000)) => {
  const corpo = exemplo(preferenciaParar)
  Object.assign(corpo.entry[0].changes[0].value.user_preferences[0], { value: valor, timestamp: em })
  return corpo
}
async function contatoExiste() {
  await consumir((await canal.mensagem(USUARIO, 'oi', 1)).eventos)
  return (await sql.um<{ id: string }>("SELECT id FROM contact_channels WHERE channel_id=? AND external_user_id=?", canalId, USUARIO))!.id
}
const marcado = (id: string) => sql.um<{ m: number | null }>('SELECT marketing_blocked_at m FROM contact_channels WHERE id=?', id)

describe('descadastro de marketing pelo WhatsApp (user_preferences)', () => {
  it('stop marca o contato e resume tira a marca', async () => {
    const id = await contatoExiste()
    expect(await marcado(id)).toEqual({ m: null })
    const parar = await canal.entregar(preferencia('stop'))
    expect(parar.status).toBe(200)
    expect(parar.eventos).toHaveLength(1)
    await consumir(parar.eventos)
    expect((await marcado(id))!.m).toBeGreaterThan(0)
    await consumir((await canal.entregar(preferencia('resume', Math.floor(Date.now() / 1000) + 5))).eventos)
    expect(await marcado(id)).toEqual({ m: null })
  })
  it('um aviso atrasado não desfaz o mais novo', async () => {
    const id = await contatoExiste()
    const agora = Math.floor(Date.now() / 1000)
    await consumir((await canal.entregar(preferencia('stop', agora))).eventos)
    await consumir((await canal.entregar(preferencia('resume', agora - 600))).eventos)
    expect((await marcado(id))!.m).toBeGreaterThan(0)
  })
  it('contato desconhecido é aceito e ignorado', async () => {
    const r = await canal.entregar(preferencia('stop'))
    expect(r.status).toBe(200)
    await consumir(r.eventos)
    expect(await sql.n("SELECT count(*) n FROM contact_channels WHERE channel_id=? AND marketing_blocked_at IS NOT NULL", canalId)).toBe(0)
  })
  it('a transmissão de modelo de marketing pula quem parou de receber marketing e envia de novo quando volta; a de utilidade segue', async () => {
    const id = await contatoExiste()
    await canal.sincronizarModelos!(canalId)
    const modelos = (await apiJson<{ templates: { id: string; name: string }[] }>('GET', 'broadcasts/options')).templates
    const local = { ...env, INBOUND: { send: async () => {} } as unknown as Queue }
    const principal = { userId: 'test-owner', workspaceId: 'a', role: 'owner' as const }
    const transmitir = async (nome: string) => {
      await new Promise(r => setTimeout(r, 1200))
      const audience = { tag: 'all', channel: 'whatsapp', channel_id: canalId }
      const b = await saveBroadcast(local as never, principal, { name: 'Aviso', content: '', status: 'sending', audience, template: { id: modelos.find(t => t.name === nome)!.id, params: {} } } as never)
      await consumeBroadcast({ body: { kind: 'broadcast', workspaceId: 'a', broadcastId: b.id }, ack: () => {}, retry: () => { throw new Error('nova tentativa') } } as never, local as never)
      return getBroadcast(local as never, principal, b.id)
    }
    const alcance = async (nome: string) => (await (await import('../../src/db/broadcasts')).estimateBroadcastAudience(local as never, principal, { tag: 'all', channel: 'whatsapp', channel_id: canalId } as never, { id: modelos.find(t => t.name === nome)!.id, params: {} } as never)).eligible
    await consumir((await canal.entregar(preferencia('stop'))).eventos)
    expect(await alcance('pos_venda'), 'estimativa: marketing não alcança quem parou').toBe(0)
    expect(await alcance('aviso_geral'), 'estimativa: utilidade alcança').toBe(1)
    const antes = sim.enviadas.length
    expect((await transmitir('pos_venda')).metrics).toMatchObject({ sent: 0, skipped: 1 })
    expect(sim.enviadas).toHaveLength(antes)
    expect((await transmitir('aviso_geral')).metrics).toMatchObject({ sent: 1 })
    await consumir((await canal.entregar(preferencia('resume', Math.floor(Date.now() / 1000) + 5))).eventos)
    expect((await transmitir('pos_venda')).metrics).toMatchObject({ sent: 1 })
    void id
  }, 30_000)
})

const saude = async () => (await apiJson<{ health: any }>('GET', `connections/${canalId}`)).health

describe('saúde da conta na conexão (webhooks da conta)', () => {
  const entregar = async (corpo: unknown, trocas: Record<string, string> = {}) => {
    const r = await canal.entregar(exemplo(corpo, trocas))
    expect(r.status).toBe(200)
    expect(r.eventos).toHaveLength(1)
    await consumir(r.eventos)
  }
  const com = (corpo: any, mudar: (valor: any, entrada: any) => void) => { const c = structuredClone(corpo); mudar(c.entry[0].changes[0].value, c.entry[0]); return exemplo(c) }
  const entregarCom = async (corpo: unknown) => { const r = await canal.entregar(corpo); expect(r.status).toBe(200); await consumir(r.eventos) }

  it('o evento de conta chega à fila e à conexão que tem aquela conta, e só a ela', async () => {
    await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state,settings) VALUES ('outra','a','whatsapp','meta_whatsapp_cloud','999','connected','{\"accountId\":\"777\"}')").run()
    await entregar(revisao)
    expect((await saude()).review).toMatchObject({ decision: 'APPROVED' })
    expect(await sql.um("SELECT provider_health h FROM channels WHERE id='outra'")).toEqual({ h: '{"alerts":{}}' })
  })
  it('qualidade e limite do número', async () => {
    await entregar(qualidade)
    expect((await saude()).quality).toMatchObject({ event: 'THROUGHPUT_UPGRADE', limit: 'TIER_UNLIMITED' })
    await entregar(limites)
    expect((await saude()).limits).toMatchObject({ maxDaily: 2000, maxNumbers: 25 })
  })
  it('alerta ativo aparece e some quando a Meta avisa que acabou; avisos repetidos não duplicam', async () => {
    await entregar(alerta)
    await entregar(alerta)
    expect(Object.keys((await saude()).alerts)).toEqual(['INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED'])
    expect((await saude()).alerts.INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED).toMatchObject({ severity: 'WARNING' })
    await entregarCom(com(alerta, (v, e) => { v.alert_info.alert_status = 'NONE'; e.time += 60 }))
    expect((await saude()).alerts).toEqual({})
  })
  it('restrição, violação, desativação e revisão; reconectar tira o aviso de conta removida', async () => {
    await entregar(restricao)
    expect((await saude()).restrictions.items.map((r: any) => r.type)).toEqual(['RESTRICTED_BIZ_INITIATED_MESSAGING', 'RESTRICTED_ADD_PHONE_NUMBER_ACTION'])
    await entregar(violacao)
    expect((await saude()).violation).toMatchObject({ type: 'ADULT' })
    await entregar(desabilitada)
    expect((await saude()).disabled).toMatchObject({ state: 'REINSTATE' })
    await entregarCom(com(excluida, (_v, e) => { e.time = 1_800_000_000 }))
    expect((await saude()).removed).toMatchObject({ event: 'deleted' })
    await entregarCom(com(reconectada, (_v, e) => { e.time = 1_800_000_100 }))
    expect((await saude()).removed).toBeUndefined()
  })
  it('um aviso atrasado não desfaz o mais novo', async () => {
    await entregarCom(com(revisao, (v, e) => { v.decision = 'REJECTED'; e.time = 1_800_000_000 }))
    await entregarCom(com(revisao, (v, e) => { v.decision = 'APPROVED'; e.time = 1_700_000_000 }))
    expect((await saude()).review).toMatchObject({ decision: 'REJECTED' })
  })
  it('qualidade do número vale só para o número do aviso (display_phone_number), não para todos da conta', async () => {
    await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state,settings) VALUES ('outro-numero','a','whatsapp','meta_whatsapp_cloud','999','connected',?)")
      .bind(JSON.stringify({ accountId: sim.waba, displayPhone: '+55 11 5555-0000' })).run()
    await giveCredentials(env as never, 'outro-numero', { accessToken: sim.token, phoneNumberId: '999', appSecret: APP_SECRET })
    const dois = async (corpo: unknown) => { const r = await canal.entregar(exemplo(corpo)); expect(r.status).toBe(200); expect(r.eventos).toHaveLength(2); await consumir(r.eventos) }
    await dois(qualidade)
    expect((await saude()).quality).toMatchObject({ event: 'THROUGHPUT_UPGRADE' })
    expect(JSON.parse((await sql.um<{ h: string }>("SELECT provider_health h FROM channels WHERE id='outro-numero'"))!.h)).not.toHaveProperty('quality')
    // O limite da conta, esse sim, vale para todos os números dela.
    await dois(limites)
    expect(JSON.parse((await sql.um<{ h: string }>("SELECT provider_health h FROM channels WHERE id='outro-numero'"))!.h).limits).toMatchObject({ maxDaily: 2000 })
  })
  it('um aviso de limites com só parte dos campos soma ao que já se sabe, não apaga o resto', async () => {
    await entregar(limites)
    await entregarCom(com(limites, (v, e) => { delete v.max_phone_numbers_per_waba; v.max_daily_conversations_per_business = 5000; e.time += 60 }))
    expect((await saude()).limits).toMatchObject({ maxDaily: 5000, maxNumbers: 25 })
  })
  it('um item de user_preferences ilegível não derruba os outros do mesmo aviso', async () => {
    const id = await contatoExiste()
    const corpo = preferencia('stop')
    corpo.entry[0].changes[0].value.user_preferences.unshift({ category: 'marketing_messages', value: 'talvez', timestamp: 'ontem' })
    await consumir((await canal.entregar(corpo)).eventos)
    expect((await marcado(id))!.m).toBeGreaterThan(0)
  })
  it('alerta encerrado não ressuscita quando chega um aviso ativo mais antigo', async () => {
    await entregarCom(com(alerta, (_v, e) => { e.time = 1_800_000_100 }))
    await entregarCom(com(alerta, (v, e) => { v.alert_info.alert_status = 'NONE'; e.time = 1_800_000_200 }))
    expect((await saude()).alerts).toEqual({})
    await entregarCom(com(alerta, (v, e) => { v.alert_info.alert_description = 'outra descrição'; e.time = 1_800_000_050 }))
    expect((await saude()).alerts).toEqual({})
    await entregarCom(com(alerta, (_v, e) => { e.time = 1_800_000_300 }))
    expect(Object.keys((await saude()).alerts)).toEqual(['INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED'])
  })
  it('conta de outro portfólio não chega aqui', async () => {
    const r = await canal.entregar(exemplo(revisao, { '<WABA_ID>': '999000' }))
    expect(r.status).toBe(401)
    expect(r.eventos).toHaveLength(0)
  })
})

describe('conta que a conexão diz ter (accountId)', () => {
  const conectarComConta = (wabaId: string) => apiJson('POST', 'connections', { kind: 'whatsapp', credentials: { accessToken: sim.token, phoneNumberId: sim.telefoneId, wabaId, appSecret: APP_SECRET, verifyToken: 'verifica-123' } }, 201,
    { ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined } as never)
  const contaGravada = async (id: string) => (await sql.um<{ a: string | null }>("SELECT json_extract(settings,'$.accountId') a FROM channels WHERE id=?", id))!.a

  it('a conta só vale se a Meta listar o número na WABA digitada (GET /{waba}/phone_numbers)', async () => {
    expect(await contaGravada(canalId)).toBe(sim.waba)
    expect(sim.chamadas.some(c => c.metodo === 'GET' && c.caminho.endsWith(`/${sim.waba}/phone_numbers`))).toBe(true)
    expect(sim.chamadas.every(c => !c.caminho.includes('whatsapp_business_account')), 'o nó do número não é perguntado pela conta').toBe(true)
    await env.DB.prepare('DELETE FROM channels WHERE id=?').bind(canalId).run()
    // WABA digitada que não lista o número: a conexão sai, mas sem conta, e não recebe os avisos de outra.
    const falsa = (await conectarComConta('999000')).connection.id
    expect(await contaGravada(falsa)).toBeNull()
    const r = await canal.entregar(exemplo(revisao, { '<WABA_ID>': '999000' }))
    expect(r.status).toBe(401)
  })
  it('uma conexão que não passa na verificação não derruba a entrega das outras', async () => {
    await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state,settings) VALUES ('sem-credencial','a','whatsapp','meta_whatsapp_cloud','888','connected',?)")
      .bind(JSON.stringify({ accountId: sim.waba })).run()
    const r = await canal.entregar(exemplo(revisao))
    expect(r.status).toBe(200)
    await consumir(r.eventos)
    expect((await saude()).review).toMatchObject({ decision: 'APPROVED' })
  })
})

describe('modelo atualizado pelo webhook, sem sincronizar', () => {
  const modelo = (nome: string) => sql.um<{ status: string; quality: string; category: string; rejection_reason: string | null }>(
    'SELECT status,quality,category,rejection_reason FROM message_templates WHERE channel_id=? AND name_human=?', canalId, nome)
  beforeEach(async () => { await canal.sincronizarModelos!(canalId) })
  const entregar = async (corpo: any, mudar: (v: any, e: any) => void) => {
    const c = structuredClone(corpo); mudar(c.entry[0].changes[0].value, c.entry[0])
    const r = await canal.entregar(exemplo(c)); expect(r.status).toBe(200); await consumir(r.eventos)
  }
  const futuro = () => Math.floor(Date.now() / 1000) + 600

  it('status: pausado e aprovado de novo', async () => {
    expect((await modelo('promo_outubro'))!.status).toBe('approved')
    await entregar(modeloAprovado, (v, e) => { v.event = 'PAUSED'; v.message_template_id = '102'; e.time = futuro() })
    expect((await modelo('promo_outubro'))!.status).toBe('paused')
    await entregar(modeloAprovado, (v, e) => { v.event = 'REINSTATED'; v.message_template_id = '102'; e.time = futuro() + 60 })
    expect((await modelo('promo_outubro'))!.status).toBe('approved')
  })
  it('rejeitado traz o motivo da Meta', async () => {
    await entregar(modeloRejeitado, (v, e) => { v.message_template_id = '102'; e.time = futuro() })
    expect(await modelo('promo_outubro')).toMatchObject({ status: 'rejected', category: 'marketing', rejection_reason: expect.stringContaining('parameters placed next to each other') })
  })
  it('qualidade do modelo', async () => {
    await entregar(modeloQualidade, (v) => { v.message_template_id = '102'; v.new_quality_score = 'RED' })
    expect((await modelo('promo_outubro'))!.quality).toBe('red')
  })
  it('categoria alterada pela Meta aparece no modelo, e o aviso de recategorização futura não muda nada', async () => {
    expect((await modelo('promo_outubro'))!.category).toBe('marketing')
    await entregar(categoriaAviso, (v, e) => { v.message_template_id = '102'; v.new_category = 'MARKETING'; v.correct_category = 'UTILITY'; e.time = futuro() })
    expect((await modelo('promo_outubro'))!.category).toBe('marketing')
    await entregar(categoriaAlterada, (v, e) => { v.message_template_id = '102'; v.previous_category = 'MARKETING'; v.new_category = 'UTILITY'; e.time = futuro() + 60 })
    expect((await modelo('promo_outubro'))!.category).toBe('utility')
  })
  it('modelo desconhecido ou de status que não conhecemos não muda nada', async () => {
    await entregar(modeloAprovado, (v, e) => { v.event = 'PAUSED'; v.message_template_id = '99999'; e.time = futuro() })
    await entregar(modeloAprovado, (v, e) => { v.event = 'ALGO_NOVO'; v.message_template_id = '102'; e.time = futuro() })
    expect((await modelo('promo_outubro'))!.status).toBe('approved')
  })
})

describe('modelo de marketing na caixa de entrada', () => {
  it('é recusado para quem parou de receber marketing; modelo de utilidade continua valendo', async () => {
    const id = await contatoExiste()
    await canal.sincronizarModelos!(canalId)
    const modelos = (await apiJson<{ templates: { id: string; name: string }[] }>('GET', 'broadcasts/options')).templates
    const conversa = (await sql.um<{ id: string }>('SELECT v.id FROM conversations v WHERE v.contact_channel_id=?', id))!.id
    const enviar = (nome: string) => api('POST', `inbox/conversations/${conversa}/messages`, { kind: 'template', template: { id: modelos.find(t => t.name === nome)!.id, params: nome === 'promo_outubro' ? { '1': 'Nara' } : {} } })
    await consumir((await canal.entregar(preferencia('stop'))).eventos)
    const marketing = await enviar('promo_outubro')
    expect(marketing.status).toBe(409)
    expect(await marketing.text()).toContain('marketing')
    expect((await enviar('promo_outubro')).status).toBe(409)
    expect((await enviar('aviso_geral')).status).toBe(201)
  })
})
