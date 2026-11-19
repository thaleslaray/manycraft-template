import { expect, it, vi } from 'vitest'
import type { ProviderCtx } from '../src/channels/contract'
import { connectionFromRow, liteRow } from '../src/channels/core/connection'
import { INSTAGRAM_GRAPH_VERSION, makeInstagramGraphProvider } from '../src/channels/instagram-graph'

const fabrica = (host: string) => makeInstagramGraphProvider({ id: 'instagram_unified', host,
  connect: async () => ({ kind: 'failed', code: 'unreachable', detail: 'teste' }), checkPermissions: async () => [], webhookChecklist: [] })
const credentials = { accountId: '12345', accessToken: 'TESTONLY' }
const ctx = (fetcher: typeof fetch, settings?: Record<string, unknown>): ProviderCtx => ({ credentials, fetch: fetcher,
  connection: connectionFromRow({ ...liteRow('instagram', 'ig-test', 'a'), external_id: '12345', provider: 'instagram_unified', ...(settings ? { settings: JSON.stringify(settings) } : {}) }) })
const chamar = async (provider: ReturnType<typeof fabrica>, c: ProviderCtx) => {
  await provider.send({ ...c, target: { kind: 'direct', externalUserId: '98765' } } as never, { kind: 'text', text: 'Oi' })
}

it('sem settings.apiBase, o provider chama o host que a fábrica recebeu (não um host fixo)', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ message_id: 'm1', recipient_id: '98765' }))
  await chamar(fabrica('https://host-a.test'), ctx(fetcher))
  await chamar(fabrica('https://host-b.test'), ctx(fetcher))
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    `https://host-a.test/${INSTAGRAM_GRAPH_VERSION}/12345/messages`, `https://host-b.test/${INSTAGRAM_GRAPH_VERSION}/12345/messages`])
})

it('settings.apiBase vale mais que o host da fábrica', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ message_id: 'm1', recipient_id: '98765' }))
  await chamar(fabrica('https://host-a.test'), ctx(fetcher, { apiBase: 'https://falso.test' }))
  expect(String(fetcher.mock.calls[0][0])).toBe(`https://falso.test/${INSTAGRAM_GRAPH_VERSION}/12345/messages`)
})
