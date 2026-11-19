import { describe, expect, it } from 'vitest'
import { metaWhatsappCloud } from '../src/channels/meta-whatsapp-cloud'
import type { Connection } from '../src/channels/contract'

// Conversa que começa num anúncio Click to WhatsApp: exemplos oficiais de replica/contratos/meta-whatsapp/exemplos/webhooks/.
const examples = import.meta.glob('../../replica/contratos/meta-whatsapp/exemplos/webhooks/messages-*.json', { query: '?raw', import: 'default', eager: true })
const user = 'BR.abc123'
function sample(file: string, patch: (message: Record<string, any>) => void = () => {}) {
  const body = JSON.parse(String(examples[`../../replica/contratos/meta-whatsapp/exemplos/webhooks/${file}.json`]).replaceAll('<PHONE_NUMBER_ID>', 'phone-a')) as any
  delete body._fonte
  const value = body.entry[0].changes[0].value
  value.contacts = [{ profile: { name: 'Sheena Nelson' }, wa_id: '5511999991234', user_id: user }]
  const [message] = value.messages
  message.id = 'wamid.AD1'; message.from_user_id = user
  patch(message)
  return body
}
const connection = { id: 'wa-a', kind: 'whatsapp', provider: 'meta_whatsapp_cloud', externalId: 'phone-a', settings: {} } as Connection
const parse = (body: unknown) => metaWhatsappCloud.parseInbound(body, connection)

describe('origem do anúncio no webhook', () => {
  it('mensagem de anúncio leva a origem neutra: id, título, clique, tipo e link', () => {
    expect(parse(sample('messages-texto-anuncio-click-to-whatsapp'))).toMatchObject([{ kind: 'message', text: 'Can I get more info about this?',
      origin: { kind: 'ad', sourceId: '<AD_ID>', sourceType: 'ad', headline: 'Chat with us', clickId: '<CTWA_CLID>', sourceUrl: 'https://fb.me/3cr4Wqqkv' } }])
  })
  it('mídia que começa a conversa também leva a origem', () => {
    const [event] = parse(sample('messages-imagem', m => { m.image.id = 'M1'; m.referral = { source_id: 'AD9', source_type: 'post', ctwa_clid: 'CLID9' } }))
    expect(event).toMatchObject({ kind: 'message', origin: { kind: 'ad', sourceId: 'AD9', sourceType: 'post', clickId: 'CLID9' } })
  })
  it('mensagem comum não tem origem, e referral malformado não derruba a mensagem', () => {
    expect(parse(sample('messages-imagem', m => { m.image.id = 'M1' }))[0]).not.toHaveProperty('origin')
    const [event] = parse(sample('messages-texto-anuncio-click-to-whatsapp', m => { m.referral = 'lixo' }))
    expect(event).toMatchObject({ kind: 'message', text: 'Can I get more info about this?' })
    expect(event).not.toHaveProperty('origin')
  })
})

// ───────── Do webhook ao contato, às variáveis e às condições do fluxo ─────────
import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, vi } from 'vitest'
import { consumeInbound } from '../src/jobs'
import { webhooks, type InboundEvent, type IntegrationEnv } from '../src/integrations'
import { upsertWhatsappIdentity } from '../src/db/contacts'
import { matchesFlowCondition } from '../src/flow/conditions'
import { contactVariableRenderer, validateMessageVariables } from '../src/db/message-variables'
import { capabilities } from '../src/channels/capabilities'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

const secret = 'TEST-APP-SECRET', phoneId = '123456789'
let queue: IntegrationEnv, accepted: InboundEvent[]
const nowSeconds = () => String(Math.floor(Date.now() / 1000))
async function signed(body: unknown) {
  const text = JSON.stringify(body)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))
  return { method: 'POST', body: text, headers: { 'X-Hub-Signature-256': `sha256=${[...sig].map(n => n.toString(16).padStart(2, '0')).join('')}` } }
}
/** O exemplo oficial, com o BSUID e o número da conexão de teste no lugar dos marcadores. */
async function receiveAd(id: string, patch: (message: Record<string, any>) => void = () => {}) {
  const body = sample('messages-texto-anuncio-click-to-whatsapp', m => { m.id = id; m.timestamp = nowSeconds(); patch(m) })
  body.entry[0].changes[0].value.metadata.phone_number_id = phoneId
  accepted = []
  expect((await webhooks.request('/meta', await signed(body), queue)).status).toBe(200)
  const batch = accepted.map(b => ({ body: b, attempts: 1, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() }))
  await consumeInbound({ messages: batch } as unknown as MessageBatch<unknown>, queue)
}
const contact = () => runtime.DB.prepare('SELECT ad_source_id,ad_source_type,ad_headline,ad_click_id,ad_source_url,ad_referred_at FROM contacts WHERE id=?').bind('c-a').first<Record<string, unknown>>()

describe('origem do anúncio no contato', () => {
  beforeEach(async () => {
    await seed(); await seedAuth()
    accepted = []
    queue = { DB: runtime.DB, MEDIA: runtime.MEDIA, ...testKeyring,
      INBOUND: { send: async (event: InboundEvent) => { accepted.push(event) } } as unknown as Queue<InboundEvent>,
      FLOW_RUN: { create: async () => ({}), get: async () => ({ sendEvent: async () => {}, status: async () => ({ status: 'running' }) }) } as unknown as NonNullable<IntegrationEnv['FLOW_RUN']> }
    await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp',?)").bind(phoneId).run()
    await giveCredentials(runtime, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: phoneId, appSecret: secret, verifyToken: 'VERIFY-TEST' })
    await upsertWhatsappIdentity(runtime.DB, 'a', { contact_id: 'c-a', channel_id: 'wa-a', bsuid: user })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('a primeira mensagem do anúncio grava anúncio, título, clique e data no contato', async () => {
    expect(await contact()).toMatchObject({ ad_source_id: null, ad_referred_at: null })
    const before = Date.now()
    await receiveAd('wamid.AD1')
    expect(await contact()).toMatchObject({ ad_source_id: '<AD_ID>', ad_source_type: 'ad', ad_headline: 'Chat with us', ad_click_id: '<CTWA_CLID>', ad_source_url: 'https://fb.me/3cr4Wqqkv',
      ad_referred_at: expect.any(Number) })
    expect(((await contact())!.ad_referred_at as number)).toBeGreaterThan(before - 5000)
  })
  it('um segundo clique em outro anúncio não troca a primeira origem; mensagem sem anúncio também não apaga', async () => {
    await receiveAd('wamid.AD1')
    await receiveAd('wamid.AD2', m => { m.referral.source_id = 'OUTRO'; m.referral.ctwa_clid = 'CLID2' })
    await receiveAd('wamid.TXT', m => { delete m.referral })
    expect(await contact()).toMatchObject({ ad_source_id: '<AD_ID>', ad_click_id: '<CTWA_CLID>' })
  })
  it('as variáveis do fluxo leem a origem, com a reserva quando o contato não veio de anúncio', async () => {
    const text = 'Anúncio {{anuncio_titulo|sem}} ({{anuncio_id|x}}) {{anuncio_clique|y}}'
    await expect(validateMessageVariables(runtime.DB, 'a', [text])).resolves.toBeUndefined()
    expect(await (await contactVariableRenderer(runtime.DB, 'a', 'c-a'))(text)).toBe('Anúncio sem (x) y')
    await receiveAd('wamid.AD1')
    expect(await (await contactVariableRenderer(runtime.DB, 'a', 'c-a'))(text)).toBe('Anúncio Chat with us (<AD_ID>) <CTWA_CLID>')
  })
  it('as condições do fluxo comparam a origem: veio de anúncio, qual anúncio, há quantos dias', async () => {
    const ctx = { workspace_id: 'a', contact_id: 'c-a' }
    const rule = (field: string, operator: string, value?: unknown) => ({ match: 'all', rules: [{ type: 'system_field', field, operator, ...(value === undefined ? {} : { value }) }] })
    expect(await matchesFlowCondition(runtime.DB, ctx, rule('ad_source_id', 'is_set'))).toBe(false)
    await receiveAd('wamid.AD1')
    expect(await matchesFlowCondition(runtime.DB, ctx, rule('ad_source_id', 'is_set'))).toBe(true)
    expect(await matchesFlowCondition(runtime.DB, ctx, rule('ad_source_id', 'equals', '<AD_ID>'))).toBe(true)
    expect(await matchesFlowCondition(runtime.DB, ctx, rule('ad_headline', 'contains', 'Chat'))).toBe(true)
    expect(await matchesFlowCondition(runtime.DB, ctx, rule('ad_source_id', 'equals', 'outro'))).toBe(false)
    expect(await matchesFlowCondition(runtime.DB, ctx, rule('ad_referred_at', 'within_days', 1))).toBe(true)
  })
  it('o perfil do contato no painel traz a origem', async () => {
    await receiveAd('wamid.AD1')
    const response = await authenticatedRequest('contacts/c-a', 'a')
    expect(response.status).toBe(200)
    expect((await response.json() as any).contact).toMatchObject({ ad_source_id: '<AD_ID>', ad_headline: 'Chat with us', ad_click_id: '<CTWA_CLID>', ad_referred_at: expect.stringMatching(/^\d{4}-/) })
  })
})

describe('perfil de capacidades: referral só onde alguém lê', () => {
  it('WhatsApp oficial declara; canais que ainda não leem a origem não declaram', () => {
    const referral = (kind: string) => capabilities(kind as never).inbound.referral
    expect(referral('whatsapp')).toBe(true)
    expect(['telegram', 'instagram', 'messenger'].map(referral)).toEqual([false, false, false])
  })
})
