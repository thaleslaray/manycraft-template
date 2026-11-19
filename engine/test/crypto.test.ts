import { expect, it } from 'vitest'
import { decryptCredentials, encryptCredentials, type KeyringEnv } from '../src/channels/core/crypto'

const key = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
const v1: KeyringEnv = { CONNECTIONS_KEK_V1: key(1), CONNECTIONS_KEK_ACTIVE: '1' }
const scope = { workspaceId: 'ws-a', connectionId: 'conn-1' }
const creds = { botToken: '123:SECRET-TOKEN', webhookSecret: 'abc' }

it('cifra e decifra; o texto cifrado não contém a credencial', async () => {
  const sealed = await encryptCredentials(v1, scope, creds)
  expect(sealed.keyVersion).toBe(1)
  expect(JSON.stringify(sealed)).not.toContain('SECRET-TOKEN')
  expect(await decryptCredentials(v1, scope, sealed)).toEqual(creds)
})
it('IV único a cada cifra, mesmo para o mesmo conteúdo', async () => {
  const ivs = new Set<string>()
  for (let i = 0; i < 50; i++) ivs.add((await encryptCredentials(v1, scope, creds)).iv)
  expect(ivs.size).toBe(50)
})
it('contexto errado (outro workspace ou outra conexão) falha', async () => {
  const sealed = await encryptCredentials(v1, scope, creds)
  await expect(decryptCredentials(v1, { ...scope, workspaceId: 'ws-b' }, sealed)).rejects.toThrow()
  await expect(decryptCredentials(v1, { ...scope, connectionId: 'conn-2' }, sealed)).rejects.toThrow()
})
it('adulterar o texto cifrado ou a versão falha', async () => {
  const sealed = await encryptCredentials(v1, scope, creds)
  const bytes = Uint8Array.from(atob(sealed.ciphertext), c => c.charCodeAt(0)); bytes[0] ^= 1
  await expect(decryptCredentials(v1, scope, { ...sealed, ciphertext: btoa(String.fromCharCode(...bytes)) })).rejects.toThrow()
  await expect(decryptCredentials({ ...v1, CONNECTIONS_KEK_V2: key(2) }, scope, { ...sealed, keyVersion: 2 })).rejects.toThrow()
})
it('versão antiga da chave ainda decifra depois que a ativa muda; novas cifras usam a ativa', async () => {
  const old = await encryptCredentials(v1, scope, creds)
  const rotated: KeyringEnv = { ...v1, CONNECTIONS_KEK_V2: key(2), CONNECTIONS_KEK_ACTIVE: '2' }
  expect(await decryptCredentials(rotated, scope, old)).toEqual(creds)
  expect((await encryptCredentials(rotated, scope, creds)).keyVersion).toBe(2)
})
it('sem chave mestra configurada, recusa em vez de cifrar fraco', async () => {
  await expect(encryptCredentials({}, scope, creds)).rejects.toThrow(/CONNECTIONS_KEK|ACTIVE/)
  await expect(encryptCredentials({ CONNECTIONS_KEK_V1: 'curta', CONNECTIONS_KEK_ACTIVE: '1' }, scope, creds)).rejects.toThrow(/32 bytes/)
})
