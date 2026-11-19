import { describe, expect, it } from 'vitest'
import { capabilities } from '../src/channels/capabilities'
import { effectiveProfile, mergeProfile } from '../src/channels/core/profile-merge'
import type { ChannelType } from '../src/channels/types'

const kinds: ChannelType[] = ['telegram', 'instagram', 'messenger', 'whatsapp', 'tiktok', 'email']

describe('ficha efetiva = canal + ajuste do provedor', () => {
  it.each(kinds)('sem ajuste, %s é idêntica à ficha do canal', (kind) => {
    expect(mergeProfile(capabilities(kind), {})).toEqual(capabilities(kind))
  })
  it('não altera a ficha de entrada', () => {
    const base = capabilities('whatsapp'), before = structuredClone(base)
    mergeProfile(base, { remove: ['window'], buttons: { maxPerMessage: 1 } })
    expect(base).toEqual(before)
  })
  it('o ajuste sobrescreve só o que declara', () => {
    const base = capabilities('whatsapp')
    const merged = mergeProfile(base, { initiator: 'business_with_optin', remove: ['window', 'list'] })
    expect(merged).toEqual({ ...base, initiator: 'business_with_optin', window: null, list: null })
  })
  it('limite numérico pega o menor valor e nunca aumenta sem verificação', () => {
    const base = capabilities('whatsapp')
    const lower = mergeProfile(base, { buttons: { maxPerMessage: 2 } })
    expect(lower.buttons).toEqual({ ...base.buttons, maxPerMessage: 2 })
    const higher = mergeProfile(base, { buttons: { maxPerMessage: 9 } })
    expect(higher.buttons.maxPerMessage).toBe(3)
  })
  it('aumento só vale quando o próprio ajuste declara a chave verificada', () => {
    const merged = mergeProfile(capabilities('whatsapp'), { text: { maxLength: 8000 }, verified: { 'text.maxLength': true } })
    expect(merged.text.maxLength).toBe(8000)
  })
  it('listas fazem interseção', () => {
    const merged = mergeProfile(capabilities('messenger'), { buttons: { types: ['postback', 'url', 'bogus' as never] } })
    expect(merged.buttons.types).toEqual(['postback', 'url'])
  })
  it('remove zera o bloco e receipts.read vira falso', () => {
    const merged = mergeProfile(capabilities('instagram'), { remove: ['cards', 'quickReplies', 'receipts.read'] })
    expect(merged).toMatchObject({ cards: null, quickReplies: null, receipts: { delivered: false, read: false } })
  })
  it('carrega unstable e risk como avisos, sem tocar o resto', () => {
    const base = capabilities('whatsapp')
    const merged = mergeProfile(base, { unstable: ['buttons'], risk: { banOnColdOutreach: true } })
    expect(merged).toEqual({ ...base, unstable: ['buttons'], risk: { banOnColdOutreach: true } })
  })
  it('aplica ajuste do provedor e depois o da conexão, nessa ordem', () => {
    const merged = mergeProfile(mergeProfile(capabilities('whatsapp'), { buttons: { maxPerMessage: 2 } }), { buttons: { maxPerMessage: 1 } })
    expect(merged.buttons.maxPerMessage).toBe(1)
  })
  it('o provedor sem transporte de mídia estreita a ficha e a conexão ajusta por cima', () => {
    expect(effectiveProfile('whatsapp', 'uazapi').media).toEqual({ image: { maxBytes: 0, mime: [] }, audio: { maxBytes: 0, mime: [] }, video: { maxBytes: 0, mime: [] }, file: { maxBytes: 0, mime: [] } })
    expect(effectiveProfile('whatsapp', 'meta_whatsapp_cloud', { remove: ['window'] }).window).toBeNull()
  })
  it('API oficial do WhatsApp mantém os limites de mídia da Meta (nenhum zerado)', () => {
    const media = effectiveProfile('whatsapp', 'meta_whatsapp_cloud').media
    for (const kind of ['image', 'audio', 'video', 'file'] as const) {
      expect(media[kind]?.maxBytes, kind).toBeGreaterThan(0)
      expect(media[kind]?.mime.length, kind).toBeGreaterThan(0)
    }
    expect(media.image?.maxBytes).toBe(5e6)
    expect(media.file?.mime).toContain('application/pdf')
  })
  it('C18: nenhuma ficha efetiva excede um limite numérico do canal', () => {
    for (const kind of kinds) {
      const base = capabilities(kind), eff = effectiveProfile(kind, undefined, { text: { maxLength: 10 ** 9 } })
      expect(eff.text.maxLength).toBeLessThanOrEqual(base.text.maxLength)
    }
  })
  it('caminho verificado pode ampliar lista', () => {
    const merged = mergeProfile(capabilities('instagram'), { buttons: { types: ['postback', 'url', 'call'] }, verified: { 'buttons.types': true } })
    expect(merged.buttons.types).toEqual(['postback', 'url', 'call'])
  })
  it('canal sem provedor padrão com legacy não quebra', () => {
    expect(effectiveProfile('tiktok', 'legacy')).toEqual(capabilities('tiktok'))
  })
})
