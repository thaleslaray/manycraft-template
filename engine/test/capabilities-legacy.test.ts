import { expect, it } from 'vitest'
import { capabilities } from '../src/channels/capabilities'
import { channelAdapter } from '../src/channels'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import { providerFor } from '../src/channels/registry'

const env = { DB: {} as D1Database, TELEGRAM_BOT_TOKEN: 'TESTONLY' }

it.each(['telegram', 'whatsapp', 'instagram'] as const)('a consulta de capacidades antiga de %s devolve o mesmo objeto da ficha efetiva', (kind) => {
  expect(channelAdapter(kind, env).capabilities()).toStrictEqual(effectiveProfile(kind, providerFor(kind)))
})
it('capabilities() continua devolvendo cópia', () => {
  const caps = capabilities('whatsapp'); caps.buttons.maxPerMessage = 99
  expect(capabilities('whatsapp').buttons.maxPerMessage).toBe(3)
})

it.each([['whatsapp', 5_000_000], ['instagram', 8_000_000]] as const)('a ficha base de %s conserva o limite da plataforma também no provedor', (kind, maxBytes) => {
  expect(capabilities(kind).media.image).toEqual({ maxBytes, mime: ['image/jpeg', 'image/png'] })
  // As duas APIs da Meta enviam mídia por link e mantêm o limite da plataforma.
  expect(effectiveProfile(kind, providerFor(kind)).media.image).toEqual({ maxBytes, mime: ['image/jpeg', 'image/png'] })
})
