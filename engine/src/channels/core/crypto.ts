/** Credentials at rest: AES-256-GCM, fresh 96-bit IV per seal, AAD binds the ciphertext to its connection and key version.
 * The master keys are Worker secrets CONNECTIONS_KEK_V<n> (32 bytes, base64); CONNECTIONS_KEK_ACTIVE picks the one that seals. */
import type { Credentials } from '../contract'

export type KeyringEnv = { CONNECTIONS_KEK_ACTIVE?: string } & { [name: `CONNECTIONS_KEK_V${number}`]: string | undefined }
export type Scope = { workspaceId: string; connectionId: string }
/** Base64 text (not BLOB) so D1 and the local SQLite shim return it the same way. */
export type Sealed = { ciphertext: string; iv: string; keyVersion: number }

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unb64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0))
const aad = (scope: Scope, version: number) => new TextEncoder().encode(`${scope.workspaceId}|${scope.connectionId}|${version}`)

async function keyFor(env: KeyringEnv, version: number): Promise<CryptoKey> {
  const raw = env[`CONNECTIONS_KEK_V${version}`]
  if (!raw) throw new Error(`CONNECTIONS_KEK_V${version} is not configured`)
  let bytes: Uint8Array
  try { bytes = unb64(raw) } catch { throw new Error(`CONNECTIONS_KEK_V${version} must be 32 bytes in base64`) }
  if (bytes.length !== 32) throw new Error(`CONNECTIONS_KEK_V${version} must be 32 bytes in base64`)
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
export const activeKeyVersion = (env: KeyringEnv) => {
  const version = Number(env.CONNECTIONS_KEK_ACTIVE)
  if (!Number.isInteger(version) || version < 1) throw new Error('CONNECTIONS_KEK_ACTIVE is not configured')
  return version
}

export async function encryptCredentials(env: KeyringEnv, scope: Scope, credentials: Credentials): Promise<Sealed> {
  const keyVersion = activeKeyVersion(env)
  const key = await keyFor(env, keyVersion)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(scope, keyVersion) }, key, new TextEncoder().encode(JSON.stringify(credentials)))
  return { ciphertext: b64(new Uint8Array(data)), iv: b64(iv), keyVersion }
}

export async function decryptCredentials(env: KeyringEnv, scope: Scope, sealed: Sealed): Promise<Credentials> {
  const key = await keyFor(env, sealed.keyVersion)
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: aad(scope, sealed.keyVersion) }, key, unb64(sealed.ciphertext))
  return JSON.parse(new TextDecoder().decode(data)) as Credentials
}
