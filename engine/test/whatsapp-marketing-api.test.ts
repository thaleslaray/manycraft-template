import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { metaWhatsappCloud } from '../src/channels/meta-whatsapp-cloud'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import type { Connection } from '../src/channels/contract'
import type { OutboundMessage } from '../src/channels/types'

// Ficha wa-09. Formato: replica/contratos/meta-whatsapp/exemplos/envio/marketing-messages-template.json (P/marketing-messages/send-marketing-messages.md).
const examples = import.meta.glob('../../replica/contratos/meta-whatsapp/exemplos/envio/marketing-messages-template.json', { query: '?raw', import: 'default', eager: true })
const example = JSON.parse(String(Object.values(examples)[0]).replaceAll('<WA_USER_PHONE>', '5511999990000')) as { template: unknown; type: string; messaging_product: string; recipient_type: string; to: string }

const phoneId = '123456789'
const enabled = { marketingMessages: { enabled: true, status: 'ONBOARDED', checkedAt: 1 } }
const connection = (settings: Record<string, unknown>): Connection => ({ id: 'wa-a', workspaceId: 'a', kind: 'whatsapp', provider: 'meta_whatsapp_cloud', externalId: phoneId,
  displayName: null, status: 'connected', settings, profile: effectiveProfile('whatsapp', 'meta_whatsapp_cloud') })
const send = (settings: Record<string, unknown>, message: Partial<Extract<OutboundMessage, { kind: 'template' }>> = {}) =>
  metaWhatsappCloud.send({ connection: connection(settings), credentials: { accessToken: 'TESTONLY', phoneNumberId: phoneId }, fetch, target: { kind: 'direct', externalUserId: '5511999990000' } },
    { kind: 'template', templateId: 'hello_world', params: { language_code: 'en' }, category: 'marketing', ...message })
const urls = () => vi.mocked(fetch).mock.calls.map(c => String(c[0]))
let reply: () => Response
beforeEach(() => {
  reply = () => Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.out.1' }] })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply())
})
afterEach(() => vi.restoreAllMocks())

it('modelo MARKETING em conexão habilitada sai por /marketing_messages com o payload oficial', async () => {
  expect(await send(enabled)).toMatchObject({ ok: true, externalId: 'wamid.out.1' })
  expect(urls()).toEqual([`https://graph.facebook.com/v26.0/${phoneId}/marketing_messages`])
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]!.body))).toMatchObject({ messaging_product: example.messaging_product, to: example.to, type: example.type, template: example.template })
})
it.each([
  ['conexão sem status guardado', {}, 'marketing'],
  ['conexão não habilitada', { marketingMessages: { enabled: false, status: 'ELIGIBLE', checkedAt: 1 } }, 'marketing'],
  ['modelo UTILITY', enabled, 'utility'],
  ['modelo AUTHENTICATION', enabled, 'authentication'],
  ['modelo sem categoria', enabled, undefined],
] as const)('segue em /messages: %s', async (_name, settings, category) => {
  expect(await send({ ...settings }, { category })).toMatchObject({ ok: true })
  expect(urls()).toEqual([`https://graph.facebook.com/v26.0/${phoneId}/messages`])
})
it.each([['131063', 400], ['134100', 400], ['134101', 400], ['131055', 400], ['134102', 500]])('erro %s da Meta é recusa com o código, nunca "sem confirmação"', async (code, status) => {
  reply = () => Response.json({ error: { message: 'x', type: 'OAuthException', code: Number(code) } }, { status })
  expect(await send(enabled)).toMatchObject({ ok: false, reason: 'rejected', code })
})

it('recusa da Meta no envio leva código, subcódigo e mensagem até o aviso do operador', async () => {
  const { failureNotice } = await import('../src/channels/core/failure')
  reply = () => Response.json({ error: { message: '(#132000) Number of parameters does not match the expected number of params', type: 'OAuthException', code: 132000,
    error_subcode: 2494073, fbtrace_id: 'TRACE1', error_data: { messaging_product: 'whatsapp', details: 'body: number of localizable_params (7) does not match the expected number of params (6)' } } }, { status: 400 })
  const result = await send({}, { category: 'utility' })
  expect(result).toMatchObject({ ok: false, reason: 'rejected', code: '132000', meta: { code: 132000, message: expect.stringContaining('Number of parameters') } })
  expect(failureNotice(result)).toMatch(/132000/)
  expect(JSON.stringify(result)).not.toContain('TESTONLY')
})
