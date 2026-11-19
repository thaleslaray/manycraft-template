import { expect, it, vi } from 'vitest'
import { messengerPage } from '../src/channels/messenger-page'

const connection = { id: 'ms', kind: 'messenger', provider: 'messenger_page', externalId: '111', settings: {}, profile: {} } as never
it('modelo utility do Messenger: criado na página e enviado com messaging_type UTILITY', async () => {
  const fetch = vi.fn(async (url: unknown, _init?: RequestInit) => String(url).includes('/message_templates') ? Response.json({ id: 't1', status: 'PENDING', category: 'UTILITY' }) : Response.json({ recipient_id: '9', message_id: 'm1' }))
  const ctx = { connection, credentials: { accessToken: 't', pageId: '111' }, fetch } as never
  const created = await messengerPage.templates!.create(ctx, { name: 'pedido_enviado', category: 'utility', language: 'pt_BR', header: { type: 'none' }, body: 'Seu pedido {{1}} saiu.', examples: { '1': '123' }, footer: '', buttons: [] } as never)
  expect(created).toMatchObject({ id: 't1', status: 'pending' })
  expect(String(fetch.mock.calls[0][0])).toContain('/111/message_templates')
  const msg = { kind: 'template', templateId: 'pedido_enviado', category: 'utility', params: { language_code: 'pt_BR', '1': '123' } } as never
  expect(messengerPage.fit(msg, {} as never)).toMatchObject({ messages: [msg] })
  expect(await messengerPage.send({ ...(ctx as object), target: { kind: 'direct', externalUserId: '9' } } as never, msg)).toMatchObject({ ok: true })
  const body = JSON.parse(String(fetch.mock.calls[1][1]!.body))
  expect(body).toMatchObject({ messaging_type: 'UTILITY', message: { attachment: { payload: { template_type: 'utility', name: 'pedido_enviado' } } } })
})

