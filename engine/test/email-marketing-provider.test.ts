import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { marketingKey, resendDomain, sendViaResend } from '../src/email-channel/marketing-provider'

beforeEach(seedAuth)

it('provedor de marketing: chave cifrada, envio pela API e domínio verificado no provedor', async () => {
  expect(await (await authenticatedRequest('email/marketing-provider')).json()).toEqual({ configured: false })
  expect((await authenticatedRequest('email/marketing-provider', 'a', { method: 'PUT', body: JSON.stringify({ api_key: 're_teste_12345678' }) })).status).toBe(200)
  expect(await marketingKey(env as never, 'a')).toBe('re_teste_12345678')
  expect(await env.DB.prepare("SELECT marketing_key_ciphertext LIKE '%re_teste%' AS leak FROM email_settings WHERE workspace_id='a'").first('leak')).toBe(0)
  const fetcher = vi.fn(async (url: unknown, _init?: RequestInit) => String(url).endsWith('/emails') ? Response.json({ id: 'em_1' })
    : String(url).endsWith('/domains') ? Response.json({ data: [{ id: 'd1', name: 'loja.example', status: 'pending' }] })
    : String(url).endsWith('/verify') ? Response.json({}) : Response.json({ status: 'verified', records: [{ type: 'TXT', name: 'resend._domainkey', value: 'p=abc' }] }))
  expect(await sendViaResend('re_x', { from: { email: 'oi@loja.example', name: 'Loja' }, to: 'ana@x.test', subject: 'Oferta', text: 'oi' }, fetcher as never)).toEqual({ ok: true, id: 'em_1' })
  expect(JSON.parse(String(fetcher.mock.calls[0][1]!.body))).toMatchObject({ from: 'Loja <oi@loja.example>', to: ['ana@x.test'] })
  expect(await resendDomain('re_x', 'loja.example', fetcher as never)).toEqual({ verified: true, records: [{ type: 'TXT', name: 'resend._domainkey', value: 'p=abc' }] })
})
