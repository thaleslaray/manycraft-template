import { describe, expect, it } from 'vitest'
import { capabilities } from '../src/channels/capabilities'
import { channelAdapter, TelegramAdapter, WhatsAppAdapter, InstagramAdapter } from '../src/channels'
import { providerIds, providerFor, resolveAdapter, resolveProvider } from '../src/channels/registry'

const env = { DB: {} as D1Database, TELEGRAM_BOT_TOKEN: 'TESTONLY' }

describe('registro canal/provedor -> adaptador', () => {
  it('resolve os três canais atuais para o adaptador existente', () => {
    expect(resolveAdapter('telegram', 'telegram_bot', env)).toBeInstanceOf(TelegramAdapter)
    expect(resolveAdapter('whatsapp', 'meta_whatsapp_cloud', env)).toBeInstanceOf(WhatsAppAdapter)
    expect(resolveAdapter('instagram', 'instagram_unified', env)).toBeInstanceOf(InstagramAdapter)
  })
  it('conexão antiga (provedor legacy ou ausente) cai no provedor padrão do canal', () => {
    expect(resolveAdapter('whatsapp', 'legacy', env)).toBeInstanceOf(WhatsAppAdapter)
    expect(resolveAdapter('telegram', undefined, env)).toBeInstanceOf(TelegramAdapter)
    expect(providerFor('instagram', 'legacy')).toBe('instagram_unified')
  })
  it('par desconhecido ou incompatível falha com erro explícito', () => {
    expect(resolveAdapter('whatsapp', 'uazapi', env).capabilities().window).toBeNull()   // F5: the non official provider is registered, with no 24h window
    expect(() => resolveAdapter('instagram', 'uazapi', env)).toThrow(/uazapi.*instagram|instagram.*uazapi/)
    expect(() => resolveAdapter('telegram', 'meta_whatsapp_cloud', env)).toThrow(/telegram/)
    expect(() => resolveProvider('tiktok', undefined)).toThrow(/tiktok/)
  })
  it('todo provedor declara canais existentes e uma ficha válida', () => {
    for (const id of providerIds) {
      const entry = resolveProvider(undefined, id)
      expect(entry.kinds.length).toBeGreaterThan(0)
      for (const kind of entry.kinds) expect(capabilities(kind).type).toBe(kind)
    }
  })
  it('o adaptador do registro devolve a mesma ficha que o registro antigo', () => {
    for (const [kind, provider] of [['telegram', 'telegram_bot'], ['whatsapp', 'meta_whatsapp_cloud'], ['instagram', 'instagram_unified']] as const) {
      expect(resolveAdapter(kind, provider, env).capabilities()).toEqual(channelAdapter(kind, env).capabilities())
    }
  })
})
