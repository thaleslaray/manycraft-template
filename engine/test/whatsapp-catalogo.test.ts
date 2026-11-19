import { expect, it, vi } from 'vitest'
import { metaWhatsappCloud } from '../src/channels/meta-whatsapp-cloud'

it('catálogo do WhatsApp: primeiro catálogo da conta e seus produtos', async () => {
  const fetch = vi.fn(async (url: unknown) => String(url).includes('/product_catalogs') ? Response.json({ data: [{ id: 'cat1', name: 'Loja' }] })
    : Response.json({ data: [{ id: 'p1', retailer_id: 'sku-1', name: 'Camiseta', price: 'R$ 49,90', image_url: 'https://img.example/1.jpg', availability: 'in stock' }] }))
  const ctx = { connection: { settings: { wabaId: '123' } }, credentials: { accessToken: 't' }, fetch } as never
  const catalog = (metaWhatsappCloud as unknown as { catalog: (ctx: never) => Promise<unknown> }).catalog
  expect(await catalog(ctx)).toEqual({ catalogId: 'cat1', products: [{ id: 'p1', retailerId: 'sku-1', name: 'Camiseta', price: 'R$ 49,90', imageUrl: 'https://img.example/1.jpg', availability: 'in stock' }] })
  expect(String(fetch.mock.calls[0][0])).toContain('/123/product_catalogs')
})
