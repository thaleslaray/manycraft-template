import { expect, it } from 'vitest'
import { connectionUsernameSchema, usernamePattern } from '../src/channels/meta-account'
import { inboxResumeAutomationsSchema } from '../src/inbox/routes'

// Regra antiga do handler de POST /connections/:id/username, copiada como referência: o schema tem de aceitar e recusar o mesmo.
const antigo = (body: unknown) => { const username = String((body as { username?: unknown }).username ?? '').trim(); return usernamePattern.test(username) ? username : null }

it('connectionUsernameSchema aceita e recusa exatamente o que o handler aceitava', () => {
  const casos: unknown[] = [{ username: 'loja.ana' }, { username: '  loja_ana  ' }, { username: 'ab' }, { username: 'a'.repeat(36) }, { username: 'loja.com' },
    { username: 'loja.com.br2' }, { username: 123 }, { username: true }, { username: null }, {}, [], 'texto', 7, { username: 'ana', outro: 1 },
    { username: { a: 1 } }, { username: 'com espaço' }]
  for (const body of casos) {
    const r = connectionUsernameSchema.safeParse(body)
    expect(r.success ? r.data.username : null, JSON.stringify(body)).toBe(antigo(body))
  }
})

it('inboxResumeAutomationsSchema só aceita objeto vazio', () => {
  expect(inboxResumeAutomationsSchema.safeParse({}).success).toBe(true)
  for (const body of [{ x: 1 }, [], null, 'a']) expect(inboxResumeAutomationsSchema.safeParse(body).success).toBe(false)
})
