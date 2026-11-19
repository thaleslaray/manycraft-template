import { describe, expect, it, vi } from 'vitest'
import { capabilities } from '../src/channels/capabilities'
import type { ProviderCtx } from '../src/channels/contract'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import { instagramUnified } from '../src/channels/instagram-unified'
import { messengerPage } from '../src/channels/messenger-page'

const items = [{ title: 'Como comprar?', payload: 'surface:primeiro' }, { title: 'Falar com a equipe', payload: 'surface:segundo' }]

describe.each([
  { adapter: instagramUnified, kind: 'instagram' as const, credential: 'accountId' },
  { adapter: messengerPage, kind: 'messenger' as const, credential: 'pageId' },
])('superfícies de conversa: $kind', ({ adapter, kind, credential }) => {
  function context(response: () => Response = () => Response.json({ result: 'success' })) {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response())
    const ctx: ProviderCtx = { fetch, credentials: { accessToken: 'test-only-private-token', [credential]: '12345' }, connection: {
      id: 'ch-test', workspaceId: 'a', kind, provider: adapter.id, externalId: '12345', displayName: null, status: 'connected',
      settings: { apiBase: 'https://fake-provider.test' }, profile: effectiveProfile(kind, adapter.id),
    } }
    return { ctx, fetch }
  }

  it('declara limites na ficha efetiva da conexão', () => {
    expect(effectiveProfile(kind, adapter.id)).toMatchObject({
      conversationStarters: { maxItems: 4, titleMax: 80 }, mainMenu: { maxItems: 20, titleMax: 30 },
    })
    expect(effectiveProfile(kind, adapter.id, { mainMenu: null }).mainMenu).toBeNull()
  })

  it('publica iniciadores em ordem, usando a conta e o transporte injetados', async () => {
    const { ctx, fetch } = context()
    expect(adapter.configureSurface).toBeTypeOf('function')
    await adapter.configureSurface!(ctx, { kind: 'conversation_starters', enabled: true, items })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe('https://fake-provider.test/v26.0/12345/messenger_profile')
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer test-only-private-token' } })
    expect(JSON.parse(String(init!.body))).toEqual({ ...(kind === 'instagram' ? { platform: 'instagram' } : {}),
      ice_breakers: kind === 'instagram' ? [{ call_to_actions: items.map(item => ({ question: item.title, payload: item.payload })) }]
        : items.map(item => ({ question: item.title, payload: item.payload })) })
  })

  it('publica menu com postbacks ordenados e permite 20 itens', async () => {
    const { ctx, fetch } = context()
    const menu = Array.from({ length: 20 }, (_, index) => ({ title: `Opção ${index + 1}`, payload: `surface:${index + 1}` }))
    await adapter.configureSurface!(ctx, { kind: 'main_menu', enabled: true, items: menu })
    expect(JSON.parse(String(fetch.mock.calls[0][1]!.body))).toEqual({ ...(kind === 'instagram' ? { platform: 'instagram' } : {}),
      persistent_menu: [{ locale: 'default', ...(kind === 'messenger' ? { composer_input_disabled: false } : {}),
      call_to_actions: menu.map(item => ({ type: 'postback', ...item })),
    }] })
  })

  it.each(['conversation_starters', 'main_menu'] as const)('desativa %s removendo somente o campo correspondente', async kind => {
    const { ctx, fetch } = context()
    await adapter.configureSurface!(ctx, { kind, enabled: false, items: [] })
    expect(fetch.mock.calls[0][1]!.method).toBe('DELETE')
    expect(JSON.parse(String(fetch.mock.calls[0][1]!.body))).toEqual({ fields: [kind === 'main_menu' ? 'persistent_menu' : 'ice_breakers'] })
  })

  it('recusa limites, títulos e payloads inválidos antes de chamar o provedor', async () => {
    const { ctx, fetch } = context()
    for (const invalid of [[], Array.from({ length: 5 }, () => items[0]), [{ title: 'a'.repeat(81), payload: 'ok' }],
      [{ title: '', payload: 'ok' }], [{ title: 'Pergunta', payload: '' }], [{ title: 'Pergunta', payload: 'á'.repeat(501) }]]) {
      await expect(adapter.configureSurface!(ctx, { kind: 'conversation_starters', enabled: true, items: invalid })).rejects.toThrow('Configuração inválida')
    }
    await expect(adapter.configureSurface!(ctx, { kind: 'main_menu', enabled: true, items: [{ title: 'a'.repeat(31), payload: 'ok' }] })).rejects.toThrow('Configuração inválida')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('respeita a ficha efetiva ao remover suporte por conexão', async () => {
    const { ctx, fetch } = context()
    ctx.connection.profile.mainMenu = null
    await expect(adapter.configureSurface!(ctx, { kind: 'main_menu', enabled: true, items })).rejects.toThrow('Recurso indisponível')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('respeita limites menores definidos na conexão e recusa configuração malformada', async () => {
    const { ctx, fetch } = context()
    ctx.connection.profile.mainMenu = { maxItems: 1, titleMax: 10 }
    await expect(adapter.configureSurface!(ctx, { kind: 'main_menu', enabled: true, items })).rejects.toThrow('Configuração inválida')
    await expect(adapter.configureSurface!(ctx, { kind: 'main_menu', enabled: true, items: [{ title: 'a'.repeat(11), payload: 'ok' }] })).rejects.toThrow('Configuração inválida')
    await expect(adapter.configureSurface!(ctx, { kind: 'main_menu', enabled: true, items: [null] } as never)).rejects.toThrow('Configuração inválida')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    () => Response.json({ error: { message: 'test-only-private-token', code: 190 } }, { status: 400 }),
    () => Response.json({ result: 'failure' }),
    () => { throw new Error('test-only-private-token') },
  ])('recusa falha remota sem expor o corpo da resposta ou credencial', async response => {
    const { ctx } = context(response)
    await expect(adapter.configureSurface!(ctx, { kind: 'main_menu', enabled: true, items })).rejects.toThrow(/^Não foi possível publicar a configuração no provedor\.$/)
  })
})

it('canais sem provedor capaz não anunciam superfícies', () => {
  for (const kind of ['telegram', 'whatsapp', 'email', 'tiktok'] as const) {
    expect(capabilities(kind)).toMatchObject({ conversationStarters: null, mainMenu: null })
  }
})

describe('Messenger: saudação e digitação livre', () => {
  const ctx = (settings: Record<string, unknown> = {}) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ result: 'success' }))
    return { fetch, ctx: { fetch, credentials: { accessToken: 'tok', pageId: '12345' }, connection: { id: 'ch', workspaceId: 'a', kind: 'messenger' as const, provider: 'messenger_page' as const,
      externalId: '12345', displayName: null, status: 'connected' as const, settings: { apiBase: 'https://fake-provider.test', ...settings }, profile: effectiveProfile('messenger', 'messenger_page') } } }
  }
  it('publica e remove a saudação no perfil da página', async () => {
    const a = ctx()
    await messengerPage.applySettings!(a.ctx, { greeting: 'Oi! Toque em Começar.' })
    expect(JSON.parse(String(a.fetch.mock.calls[0][1]!.body))).toEqual({ greeting: [{ locale: 'default', text: 'Oi! Toque em Começar.' }] })
    await messengerPage.applySettings!(a.ctx, {})
    expect(a.fetch.mock.calls[1][1]).toMatchObject({ method: 'DELETE' })
  })
  it('menu principal leva o bloqueio de digitação quando a opção está ligada', async () => {
    const a = ctx({ composerDisabled: true })
    await messengerPage.configureSurface!(a.ctx, { kind: 'main_menu', enabled: true, items: [{ title: 'Comprar', payload: 'surface:x' }] })
    expect(JSON.parse(String(a.fetch.mock.calls[0][1]!.body)).persistent_menu[0].composer_input_disabled).toBe(true)
  })
})
