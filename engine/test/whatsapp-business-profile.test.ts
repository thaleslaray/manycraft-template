import { expect, it, vi } from 'vitest'
import { metaWhatsappCloud } from '../src/channels/meta-whatsapp-cloud'
import { effectiveProfile } from '../src/channels/core/profile-merge'

it('perfil comercial do WhatsApp é lido e salvo pela Cloud API do número', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_u, init) => init?.method === 'POST' ? Response.json({ success: true })
    : Response.json({ data: [{ about: 'Oficina', description: 'Consertos', email: 'a@b.test', websites: ['https://a.test'], vertical: 'AUTO' }] }))
  const ctx = { fetch, credentials: { accessToken: 'tok', phoneNumberId: '555' }, connection: { id: 'ch', workspaceId: 'a', kind: 'whatsapp' as const, provider: 'meta_whatsapp_cloud' as const,
    externalId: '555', displayName: null, status: 'connected' as const, settings: { apiBase: 'https://fake.test' }, profile: effectiveProfile('whatsapp', 'meta_whatsapp_cloud') } }
  expect(await metaWhatsappCloud.businessProfile!.get(ctx)).toMatchObject({ about: 'Oficina', websites: ['https://a.test'], vertical: 'AUTO' })
  expect(String(fetch.mock.calls[0][0])).toBe('https://fake.test/v26.0/555/whatsapp_business_profile?fields=about,address,description,email,websites,vertical')
  await metaWhatsappCloud.businessProfile!.update(ctx, { description: 'Novo', websites: ['https://x.test', 'https://y.test'] })
  expect(JSON.parse(String(fetch.mock.calls[1][1]!.body))).toEqual({ messaging_product: 'whatsapp', description: 'Novo', websites: ['https://x.test', 'https://y.test'] })
})
