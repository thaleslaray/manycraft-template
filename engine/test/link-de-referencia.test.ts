import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeInbound } from '../src/jobs'
import { webhooks, type InboundEvent, type IntegrationEnv } from '../src/integrations'
import { upsertWhatsappIdentity } from '../src/db/contacts'
import { newRefCode, refLink, prefillText } from '../src/db/ref-links'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

const secret = 'TEST-APP-SECRET', phoneId = '123456789', user = 'BR.abc123'
const examples = import.meta.glob('../../replica/contratos/meta-whatsapp/exemplos/webhooks/messages-*.json', { query: '?raw', import: 'default', eager: true })

describe('links no formato oficial da Meta', () => {
  it('wa.me com texto pré-preenchido e o código no fim; m.me e ig.me com ?ref=', () => {
    expect(refLink('whatsapp', '5511999990000', 'abcd2345', 'Quero o guia')).toBe('https://wa.me/5511999990000?text=Quero%20o%20guia%20abcd2345')
    expect(refLink('whatsapp', '5511999990000', 'abcd2345')).toBe('https://wa.me/5511999990000?text=abcd2345')
    expect(refLink('messenger', 'oficina.horizonte', 'abcd2345')).toBe('https://m.me/oficina.horizonte?ref=abcd2345')
    expect(refLink('instagram', 'oficina', 'abcd2345')).toBe('https://ig.me/m/oficina?ref=abcd2345')
    expect(prefillText('  ', 'xyz')).toBe('xyz')
  })
  it('o código tem 8 letras e números sem caracteres que se confundem', () => {
    const codes = new Set(Array.from({ length: 200 }, newRefCode))
    expect(codes.size).toBe(200)
    for (const code of codes) expect(code).toMatch(/^[a-hj-km-np-z2-9]{8}$/)
  })
})

describe('criar, editar e excluir links pela API', () => {
  beforeEach(async () => {
    await seedAuth()
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('ch-wa','a','whatsapp','wa-1'),('ch-ms','a','messenger','ms-1'),('ch-tg','a','telegram','tg-1')"),
    ])
  })
  const create = (connection_id: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}) => authenticatedRequest('automations/auto-a/triggers', 'a',
    { method: 'POST', body: JSON.stringify({ type: 'ref_url', name: 'Link da bio', connection_id, node_id: 't', config, ...extra }) })

  it('cria o link de cada canal com o endereço pronto e estado inicial', async () => {
    const wa = await (await create('ch-wa', { handle: '+55 (11) 99999-0000', text: 'Quero o guia' })).json() as any
    expect(wa).toMatchObject({ type: 'ref_url', channel_type: 'whatsapp', state: 'initial', repeat_mode: 'once_per_24_hours', config: { handle: '5511999990000', text: 'Quero o guia' } })
    expect(wa.config.link).toBe(`https://wa.me/5511999990000?text=${encodeURIComponent(`Quero o guia ${wa.config.code}`)}`)
    const ms = await (await create('ch-ms', { handle: 'https://m.me/oficina.horizonte/' })).json() as any
    expect(ms.config.link).toBe(`https://m.me/oficina.horizonte?ref=${ms.config.code}`)
    const ig = await (await create('ch-a', { handle: '@oficina' })).json() as any
    expect(ig.config.link).toBe(`https://ig.me/m/oficina?ref=${ig.config.code}`)
    for (const handle of ['ig.me/m/oficina', 'https://ig.me/m/oficina/?ref=x', 'https://www.instagram.com/oficina/', '@oficina'])
      expect((await (await create('ch-a', { handle })).json() as any).config.handle).toBe('oficina')
    const list = await (await authenticatedRequest('automations/auto-a/triggers')).json() as { rows: { type: string }[] }
    expect(list.rows.filter(r => r.type === 'ref_url')).toHaveLength(7)
  })

  it('recusa canal sem link, endereço inválido e texto longo demais', async () => {
    expect((await create('ch-tg', { handle: 'bot' })).status).toBe(400)
    expect((await create('ch-wa', { handle: '011 99999' })).status).toBe(400)
    expect((await create('ch-wa', { handle: '5511999990000', text: 'x'.repeat(135) })).status).toBe(400)
    expect((await create('ch-ms', { handle: 'nome com espaço' })).status).toBe(400)
    expect((await create('ch-a', { handle: 'a'.repeat(31) })).status).toBe(400)
    expect((await create('ch-wa', { handle: '5511999990000' }, { node_id: 'inexistente' })).status).toBe(400)
  })

  it('editar mantém o código (o link já impresso continua valendo); ativar exige automação publicada', async () => {
    const link = await (await create('ch-ms', { handle: 'oficina' })).json() as any
    const edit = async (body: unknown) => authenticatedRequest(`automations/auto-a/triggers/${link.id}`, 'a', { method: 'PATCH', body: JSON.stringify(body) })
    const renamed = await (await edit({ config: { handle: 'oficina2' }, name: 'Nova bio' })).json() as any
    expect(renamed).toMatchObject({ name: 'Nova bio', config: { code: link.config.code, link: `https://m.me/oficina2?ref=${link.config.code}` } })
    expect(await (await edit({ state: 'draft' })).json()).toMatchObject({ state: 'draft' })
    expect((await edit({ state: 'active' })).status).toBe(409)
    expect((await authenticatedRequest('automations/auto-a/publish', 'a', { method: 'POST' })).status).toBe(201)
    expect((await edit({ state: 'active' })).status).toBe(200)
    expect((await edit({ repeat_mode: 'once' })).status).toBe(200)
    expect((await authenticatedRequest(`automations/auto-a/triggers/${link.id}`, 'b', { method: 'PATCH', body: JSON.stringify({ state: 'draft' }) })).status).toBe(404)
  })

  it('gatilho antigo (config só com ref, sem endereço) aparece com o ref como código, sem link, e salvar sem endereço dá 400', async () => {
    await runtime.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,config)
      VALUES ('velho','a','auto-a','ch-ms','Antigo','widget','messenger_ref_url','active','once',?)`).bind(JSON.stringify({ node_id: 't', ref: 'bio' })).run()
    const list = await (await authenticatedRequest('automations/auto-a/triggers')).json() as { rows: any[] }
    expect(list.rows.find(r => r.id === 'velho')).toMatchObject({ type: 'ref_url', config: { code: 'bio', link: null } })
    const detail = await (await authenticatedRequest('automations/auto-a')).json() as any
    expect(detail.triggers.find((t: any) => t.id === 'velho').config.code).toBe('bio')
    const patch = (body: unknown) => authenticatedRequest('automations/auto-a/triggers/velho', 'a', { method: 'PATCH', body: JSON.stringify(body) })
    const refused = await patch({ state: 'draft' })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining('endereço') })
    expect((await authenticatedRequest('automations/auto-a/publish', 'a', { method: 'POST' })).status).toBe(201)
    const fixed = await (await patch({ config: { handle: 'oficina' } })).json() as any
    expect(fixed.config).toMatchObject({ code: 'bio', handle: 'oficina', link: 'https://m.me/oficina?ref=bio' })
  })

  it('exclui o link; só ele, e só de quem pode editar', async () => {
    const link = await (await create('ch-ms', { handle: 'oficina' })).json() as any
    const keyword = (await authenticatedRequest('automations/auto-a/triggers/trg-a', 'a', { method: 'DELETE' }))
    expect(keyword.status).toBe(404)
    await runtime.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE workspace_id='a'").run()
    expect((await authenticatedRequest(`automations/auto-a/triggers/${link.id}`, 'a', { method: 'DELETE' })).status).toBe(403)
    await runtime.DB.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id='a'").run()
    expect((await authenticatedRequest(`automations/auto-a/triggers/${link.id}`, 'a', { method: 'DELETE' })).status).toBe(200)
    // Excluir arquiva: o gatilho continua no banco (origem e métricas), mas sai das listas e não dispara.
    expect(await runtime.DB.prepare('SELECT status FROM triggers WHERE id=?').bind(link.id).first()).toEqual({ status: 'disabled' })
    const list = await (await authenticatedRequest('automations/auto-a/triggers')).json() as { rows: { id: string }[] }
    expect(list.rows.map(r => r.id)).not.toContain(link.id)
    const detail = await (await authenticatedRequest('automations/auto-a')).json() as { triggers: { id: string }[] }
    expect(detail.triggers.map(t => t.id)).not.toContain(link.id)
    expect((await authenticatedRequest(`automations/auto-a/triggers/${link.id}`, 'a', { method: 'DELETE' })).status).toBe(404)
    expect((await authenticatedRequest(`automations/auto-a/triggers/${link.id}`, 'a', { method: 'PATCH', body: JSON.stringify({ state: 'draft' }) })).status).toBe(404)
    expect((await authenticatedRequest(`automations/auto-a/trigger-metrics?trigger_id=${link.id}`)).status).toBe(200)
    const copy = await (await authenticatedRequest('automations/auto-a/duplicate', 'a', { method: 'POST' })).json() as { id: string }
    expect(await runtime.DB.prepare("SELECT count(*) n FROM triggers WHERE automation_id=? AND widget_type='messenger_ref_url'").bind(copy.id).first('n')).toBe(0)
  })

  it('só o Messenger e o Instagram informam aberturas; no WhatsApp elas aparecem como não medidas', async () => {
    const wa = await (await create('ch-wa', { handle: '5511999990000' })).json() as any
    const metrics = await (await authenticatedRequest(`automations/auto-a/trigger-metrics?trigger_id=${wa.id}`)).json() as { impressions: number | null }
    expect(metrics.impressions).toBeNull()
    const ms = await (await create('ch-ms', { handle: 'oficina' })).json() as any
    expect(await (await authenticatedRequest(`automations/auto-a/trigger-metrics?trigger_id=${ms.id}`)).json()).toMatchObject({ impressions: 0 })
  })
})

describe('WhatsApp: o código do link, dentro da mensagem, inicia a automação', () => {
  let queue: IntegrationEnv, accepted: InboundEvent[], created: ReturnType<typeof vi.fn>
  async function signed(body: unknown) {
    const text = JSON.stringify(body)
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))
    return { method: 'POST', body: text, headers: { 'X-Hub-Signature-256': `sha256=${[...sig].map(n => n.toString(16).padStart(2, '0')).join('')}` } }
  }
  async function receive(id: string, body: string) {
    const raw = JSON.parse(String(examples['../../replica/contratos/meta-whatsapp/exemplos/webhooks/messages-texto-anuncio-click-to-whatsapp.json']).replaceAll('<PHONE_NUMBER_ID>', phoneId))
    delete raw._fonte
    const value = raw.entry[0].changes[0].value
    value.contacts = [{ profile: { name: 'Sheena Nelson' }, wa_id: '5511999991234', user_id: user }]
    const [message] = value.messages
    Object.assign(message, { id, from_user_id: user, timestamp: String(Math.floor(Date.now() / 1000)) })
    delete message.referral
    message.text = { body }
    value.metadata.phone_number_id = phoneId
    accepted = []
    expect((await webhooks.request('/meta', await signed(raw), queue)).status).toBe(200)
    await consumeInbound({ messages: accepted.map(b => ({ body: b, attempts: 1, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() })) } as unknown as MessageBatch<unknown>, queue)
  }
  const runs = (trigger = 'wa-ref') => runtime.DB.prepare('SELECT count(*) n FROM flow_runs WHERE trigger_id=?').bind(trigger).first<{ n: number }>().then(r => r!.n)
  beforeEach(async () => {
    await seed(); await seedAuth()
    accepted = []; created = vi.fn(async () => ({}))
    queue = { DB: runtime.DB, MEDIA: runtime.MEDIA, ...testKeyring,
      INBOUND: { send: async (event: InboundEvent) => { accepted.push(event) } } as unknown as Queue<InboundEvent>,
      FLOW_RUN: { create: created, get: async () => ({ sendEvent: async () => {}, status: async () => ({ status: 'running' }) }) } as unknown as NonNullable<IntegrationEnv['FLOW_RUN']> }
    await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp',?)").bind(phoneId).run()
    await giveCredentials(runtime, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: phoneId, appSecret: secret, verifyToken: 'VERIFY-TEST' })
    await upsertWhatsappIdentity(runtime.DB, 'a', { contact_id: 'c-a', channel_id: 'wa-a', bsuid: user })
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) SELECT 'v-ref','a','auto-a',1,draft_graph FROM automations WHERE id='auto-a'"),
      runtime.DB.prepare("UPDATE automations SET status='live',published_version_id='v-ref' WHERE id='auto-a'"),
      runtime.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,config)
        VALUES ('wa-ref','a','auto-a','wa-a','Link do site','widget','messenger_ref_url','active','once',?)`).bind(JSON.stringify({ node_id: 't', code: 'abcd2345', handle: '5511999990000', text: 'Quero o guia' })),
    ])
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('mensagem com o código do link começa a automação do link, uma vez por contato', async () => {
    await receive('wamid.R1', 'Quero o guia abcd2345')
    expect(await runs()).toBe(1)
    expect(created).toHaveBeenCalledTimes(1)
    await receive('wamid.R2', 'Quero o guia ABCD2345')
    expect(await runs()).toBe(1)
    // Família link de referência: o contato novo entra marcado com o gatilho do link.
    expect(await runtime.DB.prepare("SELECT c.optin_source FROM contacts c JOIN flow_runs r ON r.contact_id=c.id WHERE r.trigger_id='wa-ref'").first('optin_source')).toBe('trigger:wa-ref')
  })
  it('mensagem sem o código, ou com código de outro link, não começa a automação do link', async () => {
    await receive('wamid.R3', 'Quero o guia')
    await receive('wamid.R4', 'Quero o guia zzzz9999')
    expect(await runs()).toBe(0)
  })
  it('o código só vale como último token e com o texto pré-preenchido: no meio da frase, colado em outra palavra ou com outro texto, não', async () => {
    await receive('wamid.R6', 'abcd2345 quero o guia')
    await receive('wamid.R7', 'Quero o guia xabcd2345')
    await receive('wamid.R8', 'Preciso de ajuda abcd2345')
    await receive('wamid.R9', 'abcd2345')
    expect(await runs()).toBe(0)
    await receive('wamid.R10', '  quero   o GUIA   abcd2345  ')
    expect(await runs()).toBe(1)
  })
  it('link desligado não começa nada', async () => {
    await runtime.DB.prepare("UPDATE triggers SET status='draft' WHERE id='wa-ref'").run()
    await receive('wamid.R5', 'Quero o guia abcd2345')
    expect(await runs()).toBe(0)
  })
})

describe('código do link: único no canal, também ao duplicar e ao migrar', () => {
  beforeEach(async () => {
    await seedAuth()
    await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('ch-ms','a','messenger','ms-1')").run()
  })
  const ref = (id: string, code: string, created = 1) => runtime.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,config,created_at)
    VALUES (?,'a','auto-a','ch-ms',?,'widget','messenger_ref_url','draft','once',?,?)`).bind(id, id, JSON.stringify({ node_id: 't', code, handle: 'oficina' }), created)

  it('duplicar a automação dá código novo ao link da cópia', async () => {
    await ref('r1', 'abcd2345').run()
    const copy = await (await authenticatedRequest('automations/auto-a/duplicate', 'a', { method: 'POST' })).json() as { id: string }
    const codes = (await runtime.DB.prepare("SELECT automation_id a, json_extract(config,'$.code') code FROM triggers WHERE widget_type='messenger_ref_url'").all<{ a: string; code: string }>()).results
    expect(codes).toHaveLength(2)
    expect(codes.find(c => c.a === 'auto-a')!.code).toBe('abcd2345')
    expect(codes.find(c => c.a === copy.id)!.code).toMatch(/^[a-hj-km-np-z2-9]{8}$/)
    expect(codes.find(c => c.a === copy.id)!.code).not.toBe('abcd2345')
  })
  it('o banco recusa dois links com o mesmo código no mesmo canal', async () => {
    await ref('r1', 'abcd2345').run()
    await expect(ref('r2', 'abcd2345').run()).rejects.toThrow()
  })
  it('a migração 0058 troca o código repetido e deixa o do gatilho mais antigo', async () => {
    await runtime.DB.prepare('DROP INDEX triggers_codigo_de_referencia').run()
    await runtime.DB.batch([ref('velho', 'abcd2345', 1), ref('novo', 'abcd2345', 2), ref('outro', 'zzzz9999', 3)])
    const migration = runtime.TEST_MIGRATIONS.find(m => m.name.startsWith('0058'))!
    for (const query of migration.queries) await runtime.DB.prepare(query).run()
    const code = async (id: string) => (await runtime.DB.prepare("SELECT json_extract(config,'$.code') c FROM triggers WHERE id=?").bind(id).first<{ c: string }>())!.c
    expect(await code('velho')).toBe('abcd2345')
    expect(await code('outro')).toBe('zzzz9999')
    expect(await code('novo')).toMatch(/^[a-hj-km-np-z2-9]{8}$/)
    expect(await code('novo')).not.toBe('abcd2345')
  })
})

describe('migração 0057: widget sem conexão', () => {
  const legacy = (id: string, widget: string, status = 'active') => runtime.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,config)
    VALUES (?,'a','auto-a',NULL,?,'widget',?,?,'once','{}')`).bind(id, id, widget, status)
  it('escolhe o canal pelo tipo, prefere a conexão conectada e não apaga o que não tem conexão', async () => {
    await seedAuth()
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id,status,created_at) VALUES ('ms-velha','a','messenger','m1','disconnected',1),('ms-ok','a','messenger','m2','connected',2),('wa-1','a','whatsapp','w1','connected',3)"),
      runtime.DB.prepare('DROP TRIGGER triggers_widget_exige_conexao_insert'), runtime.DB.prepare('DROP TRIGGER triggers_widget_exige_conexao_update'),
      legacy('l-ref', 'messenger_ref_url'), legacy('l-ctwa', 'ctwa_trigger'), legacy('l-tiktok', 'tiktok_ads_ctx'), legacy('l-story', 'instagram_story_reply', 'initial'),
    ])
    await runtime.DB.prepare("DELETE FROM channels WHERE id='ch-a'").run()
    const migration = runtime.TEST_MIGRATIONS.find(m => m.name.startsWith('0057'))!
    for (const query of migration.queries.slice(0, 2)) await runtime.DB.prepare(query).run()
    for (const query of migration.queries.slice(2)) await runtime.DB.prepare(query).run()   // as regras voltam para os próximos testes
    const row = async (id: string) => runtime.DB.prepare('SELECT channel_id,status FROM triggers WHERE id=?').bind(id).first<{ channel_id: string | null; status: string }>()
    expect(await row('l-ref')).toEqual({ channel_id: 'ms-ok', status: 'active' })
    expect(await row('l-ctwa')).toEqual({ channel_id: 'wa-1', status: 'active' })
    expect(await row('l-tiktok')).toEqual({ channel_id: null, status: 'draft' })
    expect(await row('l-story')).toEqual({ channel_id: null, status: 'draft' })
  })
  it('depois da migração só rascunho fica sem conexão', async () => {
    await seedAuth()
    await expect(legacy('x', 'ctwa_trigger', 'active').run()).rejects.toThrow()
    await legacy('y', 'ctwa_trigger', 'draft').run()
    await expect(runtime.DB.prepare("UPDATE triggers SET status='active' WHERE id='y'").run()).rejects.toThrow()
  })
})

describe('Telegram: link t.me com start', () => {
  beforeEach(async () => { await seedAuth(); await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('ch-tg2','a','telegram','tg-2')").run() })
  it('cria o link t.me/<bot>?start=<código> e "/start <código>" reconhece o gatilho', async () => {
    const created = await authenticatedRequest('automations/auto-a/triggers', 'a', { method: 'POST', body: JSON.stringify({ type: 'ref_url', name: 'Bot', connection_id: 'ch-tg2', node_id: 't', config: { handle: '@minhaloja_bot' } }) })
    const tg = await created.json() as any
    expect(tg.config.link).toBe(`https://t.me/minhaloja_bot?start=${tg.config.code}`)
    await runtime.DB.prepare("UPDATE triggers SET status='active' WHERE id=?").bind(tg.id).run()
    await runtime.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-tg','a','auto-a',1,(SELECT draft_graph FROM automations WHERE id='auto-a'))").run()
    await runtime.DB.prepare("UPDATE automations SET status='live',published_version_id='v-tg' WHERE id='auto-a'").run()
    const { refByText } = await import('../src/flow/ref-dispatch')
    const { refTextOf } = await import('../src/channels/ref-link')
    expect((await refByText(runtime as never, 'a', 'ch-tg2', refTextOf('telegram', `/start ${tg.config.code}`)))?.id).toBe(tg.id)
  })
})
