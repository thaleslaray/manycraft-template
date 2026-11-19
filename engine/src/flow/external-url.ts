/** Pure helpers for the external request action: address screening and JSON path extraction. */

export class ExternalRequestError extends Error {
  readonly code: ExternalErrorCode
  constructor(code: ExternalErrorCode, message: string) { super(message); this.code = code }
}
export type ExternalErrorCode = 'invalid_url' | 'blocked_address' | 'redirect' | 'timeout' | 'network' | 'http_status'
  | 'invalid_json' | 'path_not_found' | 'invalid_value' | 'too_large'

const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function privateIpv4(host: string): boolean {
  const match = ipv4.exec(host)
  if (!match) return false
  const [a, b] = [Number(match[1]), Number(match[2])]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
    || a >= 224
}

/** True for hosts that point inside a network: loopback, private ranges, link-local, metadata and internal-only names. */
export function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host) return true
  if (host.includes(':')) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
    if (mapped) return privateIpv4(mapped[1])
    // Hex form of an IPv4-mapped address (::ffff:7f00:1) and every other mapped/compat form are refused outright.
    return host === '::' || host === '::1' || host.startsWith('::ffff:') || host.startsWith('::') || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
  }
  if (privateIpv4(host)) return true
  if (ipv4.test(host)) return false
  return !host.includes('.') || host === 'localhost' || /\.(localhost|local|internal|lan|home|corp|intranet|localdomain)$/.test(host)
    || host === 'metadata.google.internal'
}

/** Variables may only appear after the host, so the destination never depends on contact data. */
export const variablePlaceholder = /\{\{[^{}]*\}\}|\{(?:primeiro_nome|sobrenome)\}/g

export function staticUrlIssue(raw: string): string | null {
  if (!/^https?:\/\/[^/?#{}]+/i.test(raw.trim())) return 'Informe um endereço http ou https; variáveis só podem aparecer depois do domínio.'
  let url: URL
  try { url = new URL(raw.trim().replace(variablePlaceholder, 'x')) } catch { return 'Endereço inválido.' }
  if (url.username || url.password) return 'Não coloque usuário ou senha no endereço; use um cabeçalho.'
  if (isInternalHost(url.hostname)) return 'Endereços internos ou de rede local não são permitidos.'
  return null
}

/** `data.items[0].name` or `items.0.name`; returns undefined when any step is missing. */
export function extractPath(value: unknown, path: string): unknown {
  const steps = path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  if (!steps.length) return undefined
  let current: unknown = value
  for (const step of steps) {
    if (current === null || typeof current !== 'object') return undefined
    if (Array.isArray(current) ? !/^\d+$/.test(step) : !Object.hasOwn(current, step)) return undefined
    current = (current as Record<string, unknown>)[step]
  }
  return current
}
