import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { instagramUnified } from '../src/channels/instagram-unified'
import { connectionFromRow, liteRow } from '../src/channels/core/connection'
import { getContact } from '../src/db/contacts'
import { seed } from './fixtures'

beforeEach(seed)

it('perfil do Instagram traz segue a conta, a conta segue, verificado e seguidores', async () => {
  const connection = connectionFromRow(liteRow('instagram', 'test', 'a'))
  const urls: string[] = []
  const profile = await instagramUnified.fetchProfile!({ connection, credentials: { accessToken: 'TESTONLY', accountId: '123' }, fetch: (async url => {
    urls.push(String(url))
    return Response.json({ name: 'Ana Lima', username: 'ana', follower_count: 1520, is_user_follow_business: true, is_business_follow_user: false, is_verified_user: false })
  }) as typeof fetch }, { externalUserId: '1784140000000001', addressKind: 'igsid' })
  expect(urls[0]).toContain('is_user_follow_business')
  expect(profile).toMatchObject({ firstName: 'Ana', lastName: 'Lima', username: 'ana',
    channelFields: { follows_business: true, business_follows_contact: false, verified: false, follower_count: 1520 } })
})

it('o detalhe do contato devolve os campos do canal guardados no vínculo', async () => {
  await env.DB.prepare(`UPDATE contact_channels SET channel_fields='{"follows_business":true,"follower_count":9}' WHERE contact_id='c-a'`).run()
  const detail = await getContact(env.DB, 'a', 'c-a')
  expect(detail?.channels[0]?.channel_fields).toEqual({ follows_business: true, follower_count: 9 })
  await env.DB.prepare(`UPDATE contact_channels SET channel_fields=NULL WHERE contact_id='c-a'`).run()
  expect((await getContact(env.DB, 'a', 'c-a'))?.channels[0]?.channel_fields).toEqual({})
})
