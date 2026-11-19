import type { ContactOrigin } from './types'

/** Conversa aberta por anúncio no Messenger e no Instagram (referral source=ADS, com ad_id e ads_context_data). */
export function adOriginOf(referral: unknown): ContactOrigin | undefined {
  if (!referral || typeof referral !== 'object') return undefined
  const r = referral as { source?: unknown; ad_id?: unknown; ads_context_data?: { ad_title?: unknown; photo_url?: unknown; post_id?: unknown } }
  if (String(r.source).toUpperCase() !== 'ADS' || typeof r.ad_id !== 'string' && typeof r.ad_id !== 'number') return undefined
  const context = r.ads_context_data ?? {}
  return { kind: 'ad', sourceId: String(r.ad_id), sourceType: 'ad', ...(typeof context.ad_title === 'string' ? { headline: context.ad_title } : {}), ...(typeof context.photo_url === 'string' ? { sourceUrl: context.photo_url } : {}) }
}
/** Tipo de gatilho de anúncio de cada canal (o motor não conhece nomes de canal fora daqui). */
export const AD_WIDGET_BY_KIND: Record<string, string> = { whatsapp: 'ctwa_trigger', instagram: 'ads' }
export const AD_WIDGETS = Object.values(AD_WIDGET_BY_KIND)
