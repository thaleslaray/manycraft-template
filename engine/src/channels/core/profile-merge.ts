import { capabilities } from '../capabilities'
import type { ChannelKind, ChannelProfile, ProfilePatch, StoredProvider } from '../contract'
import { hasDefaultProvider, providerFor, providers } from '../providers'

type Bag = Record<string, unknown>
const isObject = (v: unknown): v is Bag => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Merge rules: numeric limits never increase and lists only intersect, unless the patch marks the
 * dotted path verified (e.g. verified['text.maxLength']); scalars and new blocks are taken as declared; null drops a block. */
function mergeInto(target: Bag, patch: Bag, verified: Record<string, boolean>, prefix = '') {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || key === 'verified') continue
    const current = target[key]
    const widen = verified[prefix + key] === true
    if (typeof value === 'number' && typeof current === 'number') target[key] = value <= current || widen ? value : current
    else if (Array.isArray(value) && Array.isArray(current)) target[key] = widen ? structuredClone(value) : current.filter((item) => value.includes(item))
    else if (isObject(value) && isObject(current)) mergeInto(current, value, verified, `${prefix}${key}.`)
    else target[key] = structuredClone(value)
  }
}

/** Pure: channel profile + one patch. Call it once per layer (provider, then connection override). */
export function mergeProfile(base: ChannelProfile, patch: ProfilePatch): ChannelProfile {
  const { remove, ...rest } = patch
  const out = structuredClone(base) as unknown as Bag
  const patchVerified = (rest as Bag).verified
  mergeInto(out, rest as Bag, isObject(patchVerified) ? (patchVerified as Record<string, boolean>) : {})
  if (isObject(patchVerified)) out.verified = { ...(out.verified as Bag), ...patchVerified }
  for (const item of remove ?? []) {
    if (item === 'receipts.read') out.receipts = { ...(out.receipts as Bag), read: false }
    else out[item] = null
  }
  return out as unknown as ChannelProfile
}

/** Channel profile + provider patch + per-connection override (channels.capabilities_override). */
export function effectiveProfile(kind: ChannelKind, provider?: StoredProvider, overrides?: ProfilePatch): ChannelProfile {
  const patch = (provider && provider !== 'legacy') || hasDefaultProvider(kind) ? providers[providerFor(kind, provider)].patch : {}
  const layered = mergeProfile(capabilities(kind), patch)
  return overrides ? mergeProfile(layered, overrides) : layered
}
