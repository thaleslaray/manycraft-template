import { expect, it, vi } from 'vitest'
import { messengerPage } from '../src/channels/messenger-page'
import type { Connection } from '../src/channels/contract'

const connection = { id: 'ms-a', kind: 'messenger', provider: 'messenger_page', externalId: '111', settings: {}, profile: { comments: { privateReply: { textMaxLength: 2000, urlButtonsMax: 1 } } } } as unknown as Connection
const feed = (value: Record<string, unknown>) => ({ object: 'page', entry: [{ id: '111', time: 1, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', post_id: '111_9', comment_id: '9_1', message: 'quero', from: { id: '555', name: 'Ana' }, created_time: 1700000000, ...value } }] }] })

it('comentário em post da página: visitante no 1º nível vira evento de comentário; página e respostas a comentários ficam de fora', async () => {
  expect(messengerPage.parseInbound(feed({}), connection)).toMatchObject([{ kind: 'comment', commentId: '9_1', postId: '111_9', text: 'quero', from: { externalUserId: '555' } }])
  expect(messengerPage.parseInbound(feed({ from: { id: '111' } }), connection)[0]).toMatchObject({ kind: 'ignored' })
  expect(messengerPage.parseInbound(feed({ parent_id: '9_0' }), connection)[0]).toMatchObject({ kind: 'ignored' })
  const items = await messengerPage.splitDelivery!(feed({}))
  expect(items).toEqual([expect.objectContaining({ eventKey: 'feed:9_1:add' })])
  expect(messengerPage.parseInbound(items[0].payload, connection)).toMatchObject([{ kind: 'comment', commentId: '9_1' }])
})
it('curtir e responder em público usam a Graph API da página', async () => {
  const fetch = vi.fn(async (_u: unknown, _i?: RequestInit) => Response.json({ id: 'r1', success: true }))
  const ctx = { connection: { ...connection, settings: {} }, credentials: { accessToken: 't', pageId: '111' }, fetch } as never
  expect(await messengerPage.comments!.replyPublic(ctx, { commentId: '9_1', text: 'Oi' })).toMatchObject({ ok: true })
  expect(String(fetch.mock.calls[0][0])).toContain('/9_1/comments')
  expect(await messengerPage.comments!.like(ctx, { commentId: '9_1' })).toMatchObject({ ok: true, externalId: '9_1' })
})
