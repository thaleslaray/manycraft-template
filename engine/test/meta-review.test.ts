import { describe, expect, it } from 'vitest'
import { metaReview } from '../src/channels/meta-review'

describe('revisão de recursos da Meta', () => {
  it('junta permissões do token e recursos de mensagem da página', async () => {
    const seen: string[] = []
    const fetcher = (async (url: string) => {
      seen.push(url)
      const data = url.endsWith('/me/permissions') ? [{ permission: 'pages_messaging', status: 'granted' }, { permission: 'ads_read', status: 'declined' }]
        : [{ feature: 'subscription_messaging', status: 'approved' }, { feature: 'human_agent', status: 'pending' }]
      return new Response(JSON.stringify({ data }))
    }) as unknown as typeof fetch
    const items = await metaReview(fetcher, 'https://g/v26.0', { accessToken: 't', pageId: '123' })
    expect(seen).toEqual(['https://g/v26.0/me/permissions', 'https://g/v26.0/123/messaging_feature_review'])
    expect(items).toEqual({ items: [
      { feature: 'pages_messaging', source: 'permission', status: 'granted' }, { feature: 'ads_read', source: 'permission', status: 'declined' },
      { feature: 'subscription_messaging', source: 'messaging_feature', status: 'approved' }, { feature: 'human_agent', source: 'messaging_feature', status: 'pending' },
    ] })
  })
  it('sem resposta útil da Meta devolve falha, com o erro dela quando há', async () => {
    const empty = (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch
    expect(await metaReview(empty, 'https://g', { accessToken: 't' })).toEqual({ failure: 'failed' })
    const refused = (async () => Response.json({ error: { code: 190, error_subcode: 463, message: 'expired' } }, { status: 400 })) as unknown as typeof fetch
    expect(await metaReview(refused, 'https://g', { accessToken: 't' })).toMatchObject({ failure: 'failed', meta: { code: 190, subcode: 463 } })
  })
  it('sem token não chama a Meta', async () => {
    const fetcher = (async () => { throw new Error('não devia chamar') }) as unknown as typeof fetch
    expect(await metaReview(fetcher, 'https://g', {})).toEqual({ failure: 'missing_credentials' })
  })
})
